export async function readPages<T>(read: (from:number, to:number) => PromiseLike<{data:T[] | null; error:unknown}>) {
  const rows: T[] = [];
  const size = 250;
  for (let from = 0; ; from += size) {
    const {data,error} = await read(from, from + size - 1);
    if (error || !data) throw new Error('Could not read all records.');
    rows.push(...data);
    if (data.length < size) return rows;
  }
}
