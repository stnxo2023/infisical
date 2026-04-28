export const honeyTokenKeys = {
  all: ["honeyTokens"] as const,
  list: (projectId: string) => [...honeyTokenKeys.all, "list", projectId] as const
};
