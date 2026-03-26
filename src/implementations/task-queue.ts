/**
 * Priority-based task queue implementation
 * FIFO within same priority level
 *
 * PERFORMANCE: Uses min-heap for O(log n) insertion instead of O(n²) array splice
 * and Map index for O(1) lookups instead of O(n) array scans
 */

import { comparePriority, Task, TaskId } from '../core/domain.js';
import { AutobeatError, ErrorCode, taskNotFound } from '../core/errors.js';
import { TaskQueue } from '../core/interfaces.js';
import { err, ok, Result } from '../core/result.js';

const DEFAULT_MAX_QUEUE_SIZE = 1000;

/** Internal heap node extending Task with insertion order for FIFO within same priority */
interface HeapNode extends Task {
  __insertionOrder: number;
}

/**
 * Min-heap based priority queue for O(log n) operations
 */
export class PriorityTaskQueue implements TaskQueue {
  private readonly heap: HeapNode[] = [];
  private readonly taskIndex: Map<TaskId, number> = new Map();
  private readonly maxQueueSize: number;
  private insertionCounter = 0; // For FIFO within same priority

  constructor(maxQueueSize: number = DEFAULT_MAX_QUEUE_SIZE) {
    this.maxQueueSize = maxQueueSize;
  }

  enqueue(task: Task): Result<void> {
    // SECURITY: Prevent unbounded queue growth (DoS protection)
    if (this.heap.length >= this.maxQueueSize) {
      return err(
        new AutobeatError(
          ErrorCode.RESOURCE_EXHAUSTED,
          `Queue is full (max size: ${this.maxQueueSize}). Cannot enqueue more tasks.`,
          { taskId: task.id, queueSize: this.heap.length, maxQueueSize: this.maxQueueSize },
        ),
      );
    }

    // Add insertion order for FIFO within same priority
    const taskWithOrder: HeapNode = { ...task, __insertionOrder: this.insertionCounter++ };

    // PERFORMANCE: O(log n) heap insertion
    this.heap.push(taskWithOrder);
    this.taskIndex.set(task.id, this.heap.length - 1);
    this.bubbleUp(this.heap.length - 1);

    return ok(undefined);
  }

  dequeue(): Result<Task | null> {
    if (this.heap.length === 0) {
      return ok(null);
    }

    const task = this.heap[0];
    this.taskIndex.delete(task.id);

    const last = this.heap.pop();
    if (this.heap.length > 0 && last) {
      this.heap[0] = last;
      this.taskIndex.set(last.id, 0);
      this.bubbleDown(0);
    }

    // Remove insertion order metadata
    const { __insertionOrder: _, ...cleanTask } = task;
    return ok(cleanTask as Task);
  }

  peek(): Result<Task | null> {
    if (this.heap.length === 0) {
      return ok(null);
    }

    const { __insertionOrder: _, ...cleanTask } = this.heap[0];
    return ok(cleanTask as Task);
  }

  remove(taskId: TaskId): Result<boolean> {
    // PERFORMANCE: O(1) lookup via index
    const index = this.taskIndex.get(taskId);

    if (index === undefined) {
      return ok(false);
    }

    this.taskIndex.delete(taskId);

    const last = this.heap.pop();
    if (index < this.heap.length && last) {
      this.heap[index] = last;
      this.taskIndex.set(last.id, index);

      // Restore heap property
      this.bubbleUp(index);
      this.bubbleDown(index);
    }

    return ok(true);
  }

  getAll(): Result<readonly Task[]> {
    // Return sorted copy without insertion order metadata
    const sorted = [...this.heap].sort((a, b) => {
      const priorityComparison = comparePriority(a.priority, b.priority);
      if (priorityComparison !== 0) return priorityComparison;
      return (a.__insertionOrder || 0) - (b.__insertionOrder || 0);
    });

    const clean = sorted.map(({ __insertionOrder: _, ...task }) => task as Task);
    return ok(Object.freeze(clean));
  }

  contains(taskId: TaskId): boolean {
    // PERFORMANCE: O(1) lookup via index
    return this.taskIndex.has(taskId);
  }

  size(): number {
    return this.heap.length;
  }

  clear(): Result<void> {
    this.heap.length = 0;
    this.taskIndex.clear();
    this.insertionCounter = 0;
    return ok(undefined);
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  /**
   * PERFORMANCE: O(log n) bubble up operation
   */
  private bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.shouldSwap(this.heap[parentIndex], this.heap[index])) {
        this.swap(parentIndex, index);
        index = parentIndex;
      } else {
        break;
      }
    }
  }

  /**
   * PERFORMANCE: O(log n) bubble down operation
   */
  private bubbleDown(index: number): void {
    while (true) {
      const leftChild = 2 * index + 1;
      const rightChild = 2 * index + 2;
      let smallest = index;

      if (leftChild < this.heap.length && this.shouldSwap(this.heap[smallest], this.heap[leftChild])) {
        smallest = leftChild;
      }

      if (rightChild < this.heap.length && this.shouldSwap(this.heap[smallest], this.heap[rightChild])) {
        smallest = rightChild;
      }

      if (smallest !== index) {
        this.swap(index, smallest);
        index = smallest;
      } else {
        break;
      }
    }
  }

  /**
   * Determine if parent should be swapped with child
   * Returns true if parent has lower priority than child
   */
  private shouldSwap(parent: HeapNode, child: HeapNode): boolean {
    const priorityComparison = comparePriority(parent.priority, child.priority);

    if (priorityComparison > 0) {
      // Parent has lower priority, should swap
      return true;
    }

    if (priorityComparison === 0) {
      // Same priority, use FIFO order
      const parentOrder = parent.__insertionOrder || 0;
      const childOrder = child.__insertionOrder || 0;
      return parentOrder > childOrder;
    }

    return false;
  }

  /**
   * Swap two elements in heap and update index
   */
  private swap(i: number, j: number): void {
    const temp = this.heap[i];
    this.heap[i] = this.heap[j];
    this.heap[j] = temp;

    // Update index
    this.taskIndex.set(this.heap[i].id, i);
    this.taskIndex.set(this.heap[j].id, j);
  }
}

/**
 * Simple FIFO queue (no priority)
 */
export class FIFOTaskQueue implements TaskQueue {
  private readonly tasks: Task[] = [];
  private readonly maxQueueSize: number;

  constructor(maxQueueSize: number = DEFAULT_MAX_QUEUE_SIZE) {
    this.maxQueueSize = maxQueueSize;
  }

  enqueue(task: Task): Result<void> {
    // SECURITY: Prevent unbounded queue growth (DoS protection)
    if (this.tasks.length >= this.maxQueueSize) {
      return err(
        new AutobeatError(
          ErrorCode.RESOURCE_EXHAUSTED,
          `Queue is full (max size: ${this.maxQueueSize}). Cannot enqueue more tasks.`,
          { taskId: task.id, queueSize: this.tasks.length, maxQueueSize: this.maxQueueSize },
        ),
      );
    }

    this.tasks.push(task);
    return ok(undefined);
  }

  dequeue(): Result<Task | null> {
    const task = this.tasks.shift();
    return ok(task || null);
  }

  peek(): Result<Task | null> {
    return ok(this.tasks[0] || null);
  }

  remove(taskId: TaskId): Result<boolean> {
    const index = this.tasks.findIndex((t) => t.id === taskId);

    if (index === -1) {
      return ok(false);
    }

    this.tasks.splice(index, 1);
    return ok(true);
  }

  getAll(): Result<readonly Task[]> {
    return ok(Object.freeze([...this.tasks]));
  }

  contains(taskId: TaskId): boolean {
    return this.tasks.some((t) => t.id === taskId);
  }

  size(): number {
    return this.tasks.length;
  }

  clear(): Result<void> {
    this.tasks.length = 0;
    return ok(undefined);
  }

  isEmpty(): boolean {
    return this.tasks.length === 0;
  }
}
