import {Plugin, TAbstractFile, TFile} from 'obsidian';
import {NestedNotesView, VIEW_TYPE} from './view';
import {NestedNotesData, DEFAULT_DATA} from './types';
import {NestedNotesSettingTab} from './settings';

type LegacyChildren = Record<string, string[]>;
type SavedNestedNotesData = Partial<NestedNotesData> & {
	children?: LegacyChildren;
};

export default class NestedNotesPlugin extends Plugin {
	data!: NestedNotesData;
	private legacyChildren: LegacyChildren | null = null;

	/** Called by Obsidian when the plugin is enabled. Registers the view, ribbon icon, command, and vault event listeners. */
	async onload(): Promise<void> {

		await this.loadPluginData();

		this.registerView(VIEW_TYPE, (leaf) => new NestedNotesView(leaf, this));

		this.addSettingTab(new NestedNotesSettingTab(this.app, this));

		this.addCommand({
			id: 'open-view',
			name: 'Open view',
			callback: () => { void this.activateView(); },
		});

		this.registerEvent(
			this.app.vault.on('create', (file: TAbstractFile) => {
				if (file instanceof TFile) this.refreshView();
			})
		);

		this.app.workspace.onLayoutReady(() => { void this.activateView(); });
	}

	/** Called by Obsidian when the plugin is disabled. Removes the custom view from all leaves. */
	onunload(): void {
		
	}

	/** Opens the Nested Notes panel in the left sidebar, or reveals it if already open. */
	async activateView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		const first = existing[0];
		if (first) {
			await this.app.workspace.revealLeaf(first);
			return;
		}
		const leaf = this.app.workspace.getLeftLeaf(false);
		if (leaf) {
			await leaf.setViewState({type: VIEW_TYPE, active: true});
		}
	}

	/** Opens the view on plugin load without stealing focus (safe to call while settings modal is open). */
	private async openViewSilently(): Promise<void> {
		if (this.app.workspace.getLeavesOfType(VIEW_TYPE).length > 0) return;
		const leaf = this.app.workspace.getLeftLeaf(false);
		if (leaf) {
			await leaf.setViewState({type: VIEW_TYPE, active: true});
		}
	}

	/** Reads persisted data from data.json and merges it with defaults. */
	async loadPluginData(): Promise<void> {
		const saved = await this.loadData() as SavedNestedNotesData | null;
		this.legacyChildren = saved?.children ?? null;
		this.data = {
			...DEFAULT_DATA,
			collapsed: saved?.collapsed ?? DEFAULT_DATA.collapsed,
			showFileIcon: saved?.showFileIcon ?? DEFAULT_DATA.showFileIcon,
			showFolderPath: saved?.showFolderPath ?? DEFAULT_DATA.showFolderPath,
		};
	}

	/** Persists the current plugin data to data.json. */
	async savePluginData(): Promise<void> {
		await this.saveData(this.data);
	}

	/** Returns old virtual nesting data once, so the view can migrate it into folders. */
	consumeLegacyChildren(): LegacyChildren | null {
		const legacyChildren = this.legacyChildren;
		this.legacyChildren = null;
		return legacyChildren;
	}

	/** Triggers a full re-render of the tree in all open Nested Notes leaves. */
	refreshView(): void {
		this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach(leaf => {
			(leaf.view as NestedNotesView).renderTree();
		});
	}
}
