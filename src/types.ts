/** Persisted plugin state stored in data.json via plugin.saveData(). */
export interface NestedNotesData {
	/** Paths of notes whose children are currently hidden (collapsed). */
	collapsed: string[];
	
	showFileIcon: boolean;
	showFolderPath: boolean;
}

export const DEFAULT_DATA: NestedNotesData = {
	collapsed: [],
	showFileIcon: true,
	showFolderPath: false,
};
