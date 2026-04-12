export interface SyncCheckpointState<TCursor = unknown, TCheckpoint = unknown> {
  sourceCheckpoint: TCheckpoint | null;
  nextCursor: TCursor | null;
  lastProcessedSummaryId: string | null;
  updatedAt: string;
}

export interface CheckpointStore<TCursor = unknown, TCheckpoint = unknown> {
  get(key: string): Promise<SyncCheckpointState<TCursor, TCheckpoint> | null>;
  set(key: string, state: SyncCheckpointState<TCursor, TCheckpoint>): Promise<void>;
  clear?(key: string): Promise<void>;
}

export class NoopCheckpointStore<TCursor = unknown, TCheckpoint = unknown> implements CheckpointStore<
  TCursor,
  TCheckpoint
> {
  async get(_key: string): Promise<SyncCheckpointState<TCursor, TCheckpoint> | null> {
    return null;
  }

  async set(_key: string, _state: SyncCheckpointState<TCursor, TCheckpoint>): Promise<void> {}

  async clear(_key: string): Promise<void> {}
}

export class MemoryCheckpointStore<TCursor = unknown, TCheckpoint = unknown> implements CheckpointStore<
  TCursor,
  TCheckpoint
> {
  private readonly store = new Map<string, SyncCheckpointState<TCursor, TCheckpoint>>();

  async get(key: string): Promise<SyncCheckpointState<TCursor, TCheckpoint> | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, state: SyncCheckpointState<TCursor, TCheckpoint>): Promise<void> {
    this.store.set(key, state);
  }

  async clear(key: string): Promise<void> {
    this.store.delete(key);
  }
}
