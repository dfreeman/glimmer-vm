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
import {
  combine,
  valueForTag,
  updateTag,
  validateTag,
  createUpdatableTag,
  Tag,
  UpdatableTag,
  Revision,
  INITIAL,
} from '@glimmer/validator';
import {
  IterationArtifacts,
  IteratorSynchronizer,
  IteratorSynchronizerDelegate,
  PathReference,
  END,
} from '@glimmer/reference';
import { expect, LinkedList, Option, Stack } from '@glimmer/util';
import { SimpleComment, SimpleNode } from '@simple-dom/interface';
import { move as moveBounds, clear } from '../bounds';
import { combineSlice } from '../utils/tags';
import { UpdatingOpcode, UpdatingOpSeq } from '../opcodes';
import { InternalVM, VmInitCallback, JitVM } from './append';
import { NewElementBuilder } from './element-builder';
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

  execute(opcodes: UpdatingOpSeq, handler: ExceptionHandler) {
    let { frameStack } = this;

    this.try(opcodes, handler);

    while (true) {
      if (frameStack.isEmpty()) break;

      let opcode = this.frame.nextStatement();

      if (opcode === null) {
        frameStack.pop();
        continue;
      }

      opcode.evaluate(this);
    }
  }

  private get frame() {
    return expect(this.frameStack.current, 'bug: expected a frame');
  }

  goto(op: UpdatingOpcode) {
    this.frame.goto(op);
  }

  try(ops: UpdatingOpSeq, handler: Option<ExceptionHandler>) {
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
  public next = null;
  public prev = null;
  readonly children: LinkedList<UpdatingOpcode>;

  protected readonly bounds: LiveBlock;

  constructor(
    protected state: ResumableVMState<InternalVM>,
    protected runtime: RuntimeContext,
    bounds: LiveBlock,
    children: LinkedList<UpdatingOpcode>
  ) {
    super();

    this.children = children;
    this.bounds = bounds;
  }

  abstract didInitializeChildren(): void;

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

  public tag: Tag;

  private _tag: UpdatableTag;

  protected bounds!: UpdatableBlock; // Hides property on base class

  constructor(
    state: ResumableVMState<InternalVM>,
    runtime: RuntimeContext,
    bounds: UpdatableBlock,
    children: LinkedList<UpdatingOpcode>
  ) {
    super(state, runtime, bounds, children);
    this.tag = this._tag = createUpdatableTag();
  }

  didInitializeChildren() {
    updateTag(this._tag, combineSlice(this.children));
  }

  evaluate(vm: UpdatingVM) {
    vm.try(this.children, this);
  }

  handleException() {
    let { state, bounds, children, prev, next, runtime } = this;

    destroyChildren(this);
    children.clear();

    let elementStack = NewElementBuilder.resume(runtime.env, bounds);
    let vm = state.resume(runtime, elementStack);

    let updating = new LinkedList<UpdatingOpcode>();

    let result = vm.execute(vm => {
      vm.pushUpdating(updating);
      vm.updateWith(this);
      vm.pushUpdating(children);
    });

    associateDestroyableChild(this, result.drop);

    this.prev = prev;
    this.next = next;
  }
}

class ListRevalidationDelegate implements IteratorSynchronizerDelegate<Environment> {
  private map: Map<unknown, BlockOpcode>;
  private updating: LinkedList<UpdatingOpcode>;

  private didInsert = false;
  private didDelete = false;

  constructor(private opcode: ListBlockOpcode, private marker: SimpleComment) {
    this.map = opcode.map;
    this.updating = opcode['children'];
  }

  insert(
    _env: Environment,
    key: unknown,
    item: PathReference<unknown>,
    memo: PathReference<unknown>,
    before: unknown
  ) {
    let { map, opcode, updating } = this;
    let nextSibling: Option<SimpleNode> = null;
    let reference: Option<BlockOpcode> = null;

    reference = map.get(before)!;
    nextSibling = reference !== undefined ? reference['bounds'].firstNode() : this.marker;

    let vm = opcode.vmForInsertion(nextSibling);
    let tryOpcode: Option<TryOpcode> = null;

    let result = vm.execute(vm => {
      vm.pushUpdating();
      tryOpcode = vm.enterItem(memo, item);
      map.set(key, tryOpcode);
    });

    updating.insertBefore(tryOpcode!, reference);

    associateDestroyableChild(opcode, result.drop);

    this.didInsert = true;
  }

  retain(
    _env: Environment,
    _key: unknown,
    _item: PathReference<unknown>,
    _memo: PathReference<unknown>
  ) {}

  move(
    _env: Environment,
    key: unknown,
    _item: PathReference<unknown>,
    _memo: PathReference<unknown>,
    before: unknown
  ) {
    let { map, updating } = this;

    let entry = map.get(key)!;

    if (before === END) {
      moveBounds(entry, this.marker);
      updating.remove(entry);
      updating.append(entry);
    } else {
      let reference = map.get(before)!;
      moveBounds(entry, reference.firstNode());
      updating.remove(entry);
      updating.insertBefore(entry, reference);
    }
  }

  delete(_env: Environment, key: unknown) {
    let { map, updating } = this;
    let opcode = map.get(key)!;
    destroy(opcode);
    clear(opcode);
    updating.remove(opcode);
    map.delete(key);

    this.didDelete = true;
  }

  done() {
    this.opcode.didInitializeChildren(this.didInsert || this.didDelete);
  }
}

export class ListBlockOpcode extends BlockOpcode {
  public type = 'list-block';
  public map = new Map<unknown, BlockOpcode>();
  public artifacts: IterationArtifacts;
  public tag: Tag;

  private lastIterated: Revision = INITIAL;
  private _tag: UpdatableTag;

  constructor(
    state: ResumableVMState<InternalVM>,
    runtime: RuntimeContext,
    bounds: LiveBlock,
    children: LinkedList<UpdatingOpcode>,
    artifacts: IterationArtifacts
  ) {
    super(state, runtime, bounds, children);
    this.artifacts = artifacts;
    let _tag = (this._tag = createUpdatableTag());
    this.tag = combine([artifacts.tag, _tag]);
  }

  didInitializeChildren(listDidChange = true) {
    this.lastIterated = valueForTag(this.artifacts.tag);

    if (listDidChange) {
      updateTag(this._tag, combineSlice(this.children));
    }
  }

  evaluate(vm: UpdatingVM) {
    let { artifacts, lastIterated } = this;

    if (!validateTag(artifacts.tag, lastIterated)) {
      let { bounds } = this;
      let { dom } = vm;

      let marker = dom.createComment('');
      dom.insertAfter(
        bounds.parentElement(),
        marker,
        expect(bounds.lastNode(), "can't insert after an empty bounds")
      );

      let target = new ListRevalidationDelegate(this, marker);
      let synchronizer = new IteratorSynchronizer({ target, artifacts, env: vm.env });

      synchronizer.sync();

      this.parentElement().removeChild(marker);
    }

    // Run now-updated updating opcodes
    super.evaluate(vm);
  }

  vmForInsertion(nextSibling: Option<SimpleNode>): InternalVM<JitOrAotBlock> {
    let { bounds, state, runtime } = this;

    let elementStack = NewElementBuilder.forInitialRender(runtime.env, {
      element: bounds.parentElement(),
      nextSibling,
    });

    return state.resume(runtime, elementStack);
  }
}

class UpdatingVMFrame {
  private current: Option<UpdatingOpcode>;

  constructor(private ops: UpdatingOpSeq, private exceptionHandler: Option<ExceptionHandler>) {
    this.current = ops.head();
  }

  goto(op: UpdatingOpcode) {
    this.current = op;
  }

  nextStatement(): Option<UpdatingOpcode> {
    let { current, ops } = this;
    if (current) this.current = ops.nextNode(current);
    return current;
  }

  handleException() {
    if (this.exceptionHandler) {
      this.exceptionHandler.handleException();
    }
  }
}
