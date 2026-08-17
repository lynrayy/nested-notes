/** Persisted plugin state stored in data.json via plugin.saveData(). */
export interface NestedNotesData {
	/** Paths of notes whose children are currently hidden (collapsed). */
	collapsed: string[];
	
	showFileIcon: boolean;
	showFolderPath: boolean;

	/**
	 * Whether the one-time migration that strips the order index from note
	 * files (keeping it only on their folders) has already run.
	 */
	fileIndexMigrated: boolean;
}

export const DEFAULT_DATA: NestedNotesData = {
	collapsed: [],
	showFileIcon: true,
	showFolderPath: false,
	fileIndexMigrated: false,
};
