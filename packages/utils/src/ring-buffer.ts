type RingBufferProxy<T> = RingBuffer<T> & { [index: number]: T | undefined };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Proxy handler must work with any RingBuffer<T>
const handler: ProxyHandler<RingBuffer<any>> = {
  get(target, prop, receiver) {
    if (typeof prop === "string" && prop !== "") {
      const n = Number(prop);
      if (Number.isInteger(n) && n >= 0) {
        return target.at(n);
      }
    }
    return Reflect.get(target, prop, receiver);
  },
  set(target, prop, value, receiver) {
    if (typeof prop === "string" && prop !== "" && Number.isInteger(Number(prop))) {
      throw new TypeError("RingBuffer does not support bracket assignment; use push()");
    }
    return Reflect.set(target, prop, value, receiver);
  },
};

export class RingBuffer<T> implements Iterable<T> {
  /** Index signature exists purely for TypeScript — actual bracket access is handled by the Proxy. */
  [index: number]: T | undefined;

  private _buffer: (T | undefined)[];
  private _head = 0;
  private _size = 0;
  private _capacity: number;

  constructor(capacity: number) {
    if (capacity < 1) throw new RangeError("capacity must be >= 1");
    this._capacity = capacity;
    this._buffer = Array.from<T | undefined>({ length: capacity });
    return new Proxy(this, handler) as RingBuffer<T>;
  }

  static from<T>(items: Iterable<T>, capacity: number): RingBufferProxy<T> {
    const rb = new RingBuffer<T>(capacity);
    for (const item of items) rb.push(item);
    return rb as RingBufferProxy<T>;
  }

  get length(): number {
    return this._size;
  }

  get capacity(): number {
    return this._capacity;
  }

  get isFull(): boolean {
    return this._size === this._capacity;
  }

  get isEmpty(): boolean {
    return this._size === 0;
  }

  push(item: T): void {
    const writeIdx = (this._head + this._size) % this._capacity;
    this._buffer[writeIdx] = item;
    if (this._size === this._capacity) {
      this._head = (this._head + 1) % this._capacity;
    } else {
      this._size++;
    }
  }

  shift(): T | undefined {
    if (this._size === 0) return undefined;
    const val = this._buffer[this._head] as T;
    this._buffer[this._head] = undefined;
    this._head = (this._head + 1) % this._capacity;
    this._size--;
    return val;
  }

  peek(): T | undefined {
    if (this._size === 0) return undefined;
    return this._buffer[this._head] as T;
  }

  peekLast(): T | undefined {
    if (this._size === 0) return undefined;
    return this._buffer[(this._head + this._size - 1) % this._capacity] as T;
  }

  at(index: number): T | undefined {
    if (index < 0) index = this._size + index;
    if (index < 0 || index >= this._size) return undefined;
    return this._buffer[(this._head + index) % this._capacity];
  }

  slice(start?: number, end?: number): T[] {
    const len = this._size;
    let s = start === undefined ? 0 : start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
    let e = end === undefined ? len : end < 0 ? Math.max(len + end, 0) : Math.min(end, len);
    if (e <= s) return [];
    const result: T[] = [];
    for (let i = s; i < e; i++) {
      result.push(this._buffer[(this._head + i) % this._capacity] as T);
    }
    return result;
  }

  filter(predicate: (value: T, index: number) => boolean): T[] {
    const result: T[] = [];
    for (let i = 0; i < this._size; i++) {
      const val = this._buffer[(this._head + i) % this._capacity] as T;
      if (predicate(val, i)) result.push(val);
    }
    return result;
  }

  map<U>(mapper: (value: T, index: number) => U): U[] {
    const result: U[] = [];
    for (let i = 0; i < this._size; i++) {
      result.push(mapper(this._buffer[(this._head + i) % this._capacity] as T, i));
    }
    return result;
  }

  reduce<U>(fn: (acc: U, value: T, index: number) => U, init: U): U;
  reduce(fn: (acc: T, value: T, index: number) => T): T;
  reduce<U>(fn: (acc: U | T, value: T, index: number) => U | T, init?: U | T): U | T {
    let acc: U | T;
    let start: number;
    if (arguments.length >= 2) {
      acc = init as U;
      start = 0;
    } else {
      if (this._size === 0) throw new TypeError("Reduce of empty ring buffer with no initial value");
      acc = this._buffer[this._head % this._capacity] as T;
      start = 1;
    }
    for (let i = start; i < this._size; i++) {
      acc = fn(acc, this._buffer[(this._head + i) % this._capacity] as T, i);
    }
    return acc;
  }

  findIndex(predicate: (value: T, index: number) => boolean): number {
    for (let i = 0; i < this._size; i++) {
      if (predicate(this._buffer[(this._head + i) % this._capacity] as T, i)) return i;
    }
    return -1;
  }

  toArray(): T[] {
    return this.slice();
  }

  clear(): void {
    this._buffer.fill(undefined);
    this._head = 0;
    this._size = 0;
  }

  *[Symbol.iterator](): IterableIterator<T> {
    for (let i = 0; i < this._size; i++) {
      yield this._buffer[(this._head + i) % this._capacity] as T;
    }
  }
}
