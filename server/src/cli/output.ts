export function printJSON(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

export function fail(message: string): never {
  throw new Error(message);
}
