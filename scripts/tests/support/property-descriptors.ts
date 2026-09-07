type PropertyDescriptorMap = Record<PropertyKey, PropertyDescriptor>;

export function installPropertyDescriptors(
  target: object,
  descriptors: PropertyDescriptorMap
) {
  const previous = new Map<PropertyKey, PropertyDescriptor | undefined>();
  for (const key of Reflect.ownKeys(descriptors)) {
    previous.set(key, Object.getOwnPropertyDescriptor(target, key));
    Object.defineProperty(target, key, descriptors[key]!);
  }

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const key of [...previous.keys()].reverse()) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    }
  };
}

export function installProperties(
  target: object,
  values: Record<PropertyKey, unknown>
) {
  return installPropertyDescriptors(
    target,
    Object.fromEntries(Reflect.ownKeys(values).map((key) => [key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: values[key]
    }]))
  );
}
