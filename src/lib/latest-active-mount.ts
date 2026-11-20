/**
 * One active owner per key, even when App Router retains a second route tree.
 * Newest mounted owner wins; previous owner resumes if the newest unmounts.
 */
export function createLatestActiveMountRegistry() {
  const instances = new Map<string, Map<symbol, () => void>>();

  function isActive(key: string, mountId: symbol): boolean {
    const mounts = instances.get(key);
    if (!mounts) return false;
    return [...mounts.keys()].at(-1) === mountId;
  }

  function subscribe(key: string, mountId: symbol, onChange: () => void): () => void {
    let mounts = instances.get(key);
    if (!mounts) {
      mounts = new Map();
      instances.set(key, mounts);
    }
    mounts.set(mountId, onChange);
    for (const notify of mounts.values()) notify();

    return () => {
      if (mounts.get(mountId) !== onChange) return;
      mounts.delete(mountId);
      if (mounts.size === 0) {
        instances.delete(key);
      } else {
        for (const notify of mounts.values()) notify();
      }
    };
  }

  return { isActive, subscribe };
}

// App Router can hydrate two copies of the same module. Document-level
// ownership is shared across bundles but isolated between tabs and requests.
type ActiveRegistry = ReturnType<typeof createLatestActiveMountRegistry>;
type RegistryHost = { __billokActivePayerReviewRegistry?: ActiveRegistry };

export function getDocumentActiveMountRegistry(
  host: object | undefined = typeof document === 'undefined' ? undefined : document,
): ActiveRegistry {
  if (!host) return createLatestActiveMountRegistry();
  const registryHost = host as RegistryHost;
  return (registryHost.__billokActivePayerReviewRegistry ??= createLatestActiveMountRegistry());
}
