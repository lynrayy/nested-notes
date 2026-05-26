/** Persisted plugin state stored in data.json via plugin.saveData(). */
export interface NestedNotesData {
	/** Maps each parent note path to an ordered list of its child note paths. */
	children: Record<string, string[]>;
	/** Paths of notes whose children are currently hidden (collapsed). */
	collapsed: string[];
	
	showFileIcon: boolean;
	showFolderPath: boolean;
}

export const DEFAULT_DATA: NestedNotesData = {
	children: {},
	collapsed: [],
	showFileIcon: false,
	showFolderPath: false,
};
