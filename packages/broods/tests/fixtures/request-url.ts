/** The URL a fetch mock was called with, whatever form the input took. */
export function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString();
}
