declare module 'acde:marktextdocs' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- Relative imports cannot declare a new ambient acde namespace.
  export const marktextdocs: import('./agentClient').DocumentsService
  export default marktextdocs
}
