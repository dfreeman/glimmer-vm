import {
  Bounds,
  DynamicScope,
  Environment,
  ExceptionHandler,
  GlimmerTreeChanges,
  JitOrAotBlock,
  RuntimeContext,
  Scope,
  AotRuntimeContext,
  JitRuntimeContext,
  ElementBuilder,
  LiveBlock,
  UpdatableBlock,
} from '@glimmer/interfaces';
import { IterationItemReference, IterableReference, OpaqueIterationItem } from '@glimmer/reference';
import { resetTracking } from '@glimmer/validator';
import { expect, Option, Stack } from '@glimmer/util';
import { SimpleComment } from '@simple-dom/interface';
import { move as moveBounds, clear } from '../bounds';
import { UpdatingOpcode } from '../opcodes';
import { InternalVM, VmInitCallback, JitVM } from './append';
import { NewElementBuilder, LiveBlockList } from './element-builder';
import { destroy, associateDestroyableChild, destroyChildren } from '../destroyables';

export default class UpdatingVM {
  public env: Environment;
  public dom: GlimmerTreeChanges;
  public alwaysRevalidate: boolean;

  private frameStack: Stack<UpdatingVMFrame> = new Stack<UpdatingVMFrame>();

  constructor(env: Environment, { alwaysRevalidate = false }) {
    this.env = env;
    this.dom = env.getDOM();
    this.alwaysRevalidate = alwaysRevalidate;
  }

  execute(opcodes: UpdatingOpcode[], handler: ExceptionHandler) {
    let { frameStack } = this;

    this.try(opcodes, handler);

    try {
      while (true) {
        if (frameStack.isEmpty()) break;

        let opcode = this.frame.nextStatement();

        if (opcode === undefined) {
          frameStack.pop();
          continue;
        }

        opcode.evaluate(this);
      }
    } catch (e) {
      resetTracking();

      throw e;
    }
  }

  private get frame() {
    return expect(this.frameStack.current, 'bug: expected a frame');
  }

  goto(index: number) {
    this.frame.goto(index);
  }

  try(ops: UpdatingOpcode[], handler: Option<ExceptionHandler>) {
    this.frameStack.push(new UpdatingVMFrame(ops, handler));
  }

  throw() {
    this.frame.handleException();
    this.frameStack.pop();
  }
}

export interface VMState {
  readonly pc: number;
  readonly scope: Scope<JitOrAotBlock>;
  readonly dynamicScope: DynamicScope;
  readonly stack: unknown[];
}

export interface ResumableVMState<V extends InternalVM> {
  resume(runtime: RuntimeContext, builder: ElementBuilder): V;
}

export class ResumableVMStateImpl<V extends InternalVM> implements ResumableVMState<V> {
  constructor(readonly state: VMState, private resumeCallback: VmInitCallback<V>) {}

  resume(
    runtime: V extends JitVM ? JitRuntimeContext : AotRuntimeContext,
    builder: ElementBuilder
  ): V {
    return this.resumeCallback(runtime, this.state, builder);
  }
}

export abstract class BlockOpcode extends UpdatingOpcode implements Bounds {
  public type = 'block';
  public children: UpdatingOpcode[];

  protected readonly bounds: LiveBlock;

  constructor(
    protected state: ResumableVMState<InternalVM>,
    protected runtime: RuntimeContext,
    bounds: LiveBlock,
    children: UpdatingOpcode[]
  ) {
    super();

    this.children = children;
    this.bounds = bounds;
  }

  parentElement() {
    return this.bounds.parentElement();
  }

  firstNode() {
    return this.bounds.firstNode();
  }

  lastNode() {
    return this.bounds.lastNode();
  }

  evaluate(vm: UpdatingVM) {
    vm.try(this.children, null);
  }
}

export class TryOpcode extends BlockOpcode implements ExceptionHandler {
  public type = 'try';

  protected bounds!: UpdatableBlock; // Hides property on base class

  evaluate(vm: UpdatingVM) {
    vm.try(this.children, this);
  }

  handleException() {
    let { state, bounds, runtime } = this;

    destroyChildren(this);

    let elementStack = NewElementBuilder.resume(runtime.env, bounds);
    let vm = state.resume(runtime, elementStack);

    let updating: UpdatingOpcode[] = [];
    let children = (this.children = []);

    let result = vm.execute(vm => {
      vm.pushUpdating(updating);
      vm.updateWith(this);
      vm.pushUpdating(children);
    });

    associateDestroyableChild(this, result.drop);
  }
}

export class ListItemOpcode extends TryOpcode {
  public retained = false;
  public seen = false;

  constructor(
    state: ResumableVMState<InternalVM>,
    runtime: RuntimeContext,
    bounds: UpdatableBlock,
    public key: unknown,
    public memo: IterationItemReference,
    public value: IterationItemReference
  ) {
    super(state, runtime, bounds, []);
  }

  updateReferences(item: OpaqueIterationItem) {
    this.retained = true;
    this.value.update(item.value);
    this.memo.update(item.memo);
  }

  shouldRemove(): boolean {
    return !this.retained;
  }

  reset() {
    this.retained = false;
    this.seen = false;
  }
}

export class ListBlockOpcode extends BlockOpcode {
  public type = 'list-block';
  public children!: ListItemOpcode[];

  private opcodeMap = new Map<unknown, ListItemOpcode>();
  private marker: SimpleComment | null = null;

  protected readonly bounds!: LiveBlockList;

  constructor(
    state: ResumableVMState<InternalVM>,
    runtime: RuntimeContext,
    bounds: LiveBlockList,
    children: ListItemOpcode[],
    private iterableRef: IterableReference
  ) {
    super(state, runtime, bounds, children);
  }

  initializeChild(opcode: ListItemOpcode) {
    this.opcodeMap.set(opcode.key, opcode);
  }

  evaluate(vm: UpdatingVM) {
    if (this.iterableRef.isDone() === false) {
      let { bounds } = this;
      let { dom } = vm;

      let marker = (this.marker = dom.createComment(''));
      dom.insertAfter(
        bounds.parentElement(),
        marker,
        expect(bounds.lastNode(), "can't insert after an empty bounds")
      );

      this.sync();

      this.parentElement().removeChild(marker);
      this.marker = null;
    }

    // Run now-updated updating opcodes
    super.evaluate(vm);
  }

  private sync() {
    let { iterableRef, opcodeMap: itemMap, children } = this;

    let item = iterableRef.next();
    let currentOpcodeIndex = 0;

    this.children = this.bounds.boundList = [];

    while (item !== null) {
      let opcode = children[currentOpcodeIndex];
      let { key } = item;

      if (opcode !== undefined && opcode === item.key) {
        this.retainItem(opcode, item);
        currentOpcodeIndex++;
      } else if (itemMap.has(key)) {
        let itemOpcode = itemMap.get(key)!;

        if (itemOpcode.seen === true) {
          this.moveItem(itemOpcode, item, opcode);
        } else {
          while (opcode.key !== key) {
            opcode.seen = true;
            opcode = children[++currentOpcodeIndex];
          }

          this.retainItem(opcode, item);
          currentOpcodeIndex++;
        }
      } else {
        this.insertItem(item, opcode);
      }

      item = iterableRef.next();
    }

    for (let i = 0; i < children.length; i++) {
      let opcode = children[i];

      if (opcode.retained === false) {
        this.deleteItem(opcode);
      } else {
        opcode.reset();
      }
    }
  }

  private retainItem(opcode: ListItemOpcode, item: OpaqueIterationItem) {
    opcode.memo.update(item.memo);
    opcode.value.update(item.value);
    opcode.retained = true;

    this.children.push(opcode);
  }

  private insertItem(item: OpaqueIterationItem, before: ListItemOpcode) {
    let { opcodeMap, bounds, state, runtime, iterableRef } = this;
    let { key } = item;
    let nextSibling = before === undefined ? this.marker : before.firstNode();

    let elementStack = NewElementBuilder.forInitialRender(runtime.env, {
      element: bounds.parentElement(),
      nextSibling,
    });

    let vm = state.resume(runtime, elementStack);

    vm.execute(vm => {
      vm.pushUpdating();
      let opcode = vm.enterItem(iterableRef, item);

      this.children.push(opcode);
      opcodeMap.set(key, opcode);
      associateDestroyableChild(this, opcode);
    });
  }

  private moveItem(opcode: ListItemOpcode, item: OpaqueIterationItem, before: ListItemOpcode) {
    opcode.memo.update(item.memo);
    opcode.value.update(item.value);
    opcode.retained = true;

    let nextSibling = before === undefined ? this.marker : before.firstNode();

    moveBounds(opcode, nextSibling);

    this.children.push(opcode);
  }

  private deleteItem(opcode: ListItemOpcode) {
    destroy(opcode);
    clear(opcode);
    this.opcodeMap.delete(opcode.key);
  }
}

class UpdatingVMFrame {
  private current = 0;

  constructor(private ops: UpdatingOpcode[], private exceptionHandler: Option<ExceptionHandler>) {}

  goto(index: number) {
    this.current = index;
  }

  nextStatement(): UpdatingOpcode | undefined {
    return this.ops[this.current++];
  }

  handleException() {
    if (this.exceptionHandler) {
      this.exceptionHandler.handleException();
    }
  }
}
