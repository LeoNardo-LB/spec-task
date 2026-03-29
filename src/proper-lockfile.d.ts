declare module "proper-lockfile" {
  interface LockOptions {
    stale?: number;
    retries?: number;
    retryWait?: number;
  }

  function lock(path: string, options?: LockOptions): Promise<() => Promise<void>>;

  namespace lock {
    function lock(path: string, options?: LockOptions): Promise<() => Promise<void>>;
  }

  export = lock;
}
