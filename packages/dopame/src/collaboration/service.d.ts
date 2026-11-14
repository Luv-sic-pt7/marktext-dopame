declare module 'acde:marktextdocs' {
  // Ambient modules cannot declare relative import statements.
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  export const marktextdocs: import('../../../dopame-system/src/agentClient').DocumentsService
}
