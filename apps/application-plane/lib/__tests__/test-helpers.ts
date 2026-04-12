/**
 * Shared test utilities
 */

/**
 * localStorage の Map ベースのモック実装
 *
 * jsdom の localStorage は setItem/getItem が別テスト間で状態を共有することがある。
 * beforeEach で Object.defineProperty して新しいインスタンスを使うことで分離できる。
 */
export function createLocalStorageMock(): Storage {
  const store = new Map<string, string>();

  return {
    clear: () => {
      store.clear();
    },
    getItem: (key: string) => store.get(key) ?? null,
    key: /* istanbul ignore next */ (index: number) =>
      [...store.keys()][index] ?? null,
    removeItem: /* istanbul ignore next */ (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    /* istanbul ignore next */
    get length() {
      return store.size;
    },
  } satisfies Storage;
}
