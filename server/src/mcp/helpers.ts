export function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data),
      },
    ],
  }
}

export function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return {
    content: [
      {
        type: 'text',
        text: message,
      },
    ],
    isError: true,
  }
}
