export async function* mergeGenerators<T>(generators: AsyncGenerator<T>[]): AsyncGenerator<T> {
  const iterators = generators.map((g) => g[Symbol.asyncIterator]());
  const activeIterators = new Set(iterators);

  while (activeIterators.size > 0) {
    const racePromises = Array.from(activeIterators).map(async (it) => ({
      it,
      result: await it.next(),
    }));

    const winner = await Promise.race(racePromises);
    const { it, result } = winner;

    if (result.done) {
      activeIterators.delete(it);
    } else {
      yield result.value;
    }
  }
}
