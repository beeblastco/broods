export interface Mutation {
  name: string;
  file: string;
  find: string;
  replace: string;
}

export interface Suite {
  name: string;
  tests: readonly string[];
  env: Readonly<Record<string, string>>;
  mutations: readonly Mutation[];
}
