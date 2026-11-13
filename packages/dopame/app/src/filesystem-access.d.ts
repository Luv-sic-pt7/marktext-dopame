export {}
declare global {
  interface Window {
    showOpenFilePicker(options?: {
      multiple?: boolean
      types?: { description?: string; accept: Record<string, string[]> }[]
    }): Promise<FileSystemFileHandle[]>
    showSaveFilePicker(options?: {
      suggestedName?: string
      types?: { description?: string; accept: Record<string, string[]> }[]
    }): Promise<FileSystemFileHandle>
    showDirectoryPicker(options?: {
      mode?: 'read' | 'readwrite'
    }): Promise<FileSystemDirectoryHandle>
  }
}
