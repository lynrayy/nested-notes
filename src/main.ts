import {Plugin, TAbstractFile, TFile} from 'obsidian';
import {NestedNotesView, VIEW_TYPE} from './view';
import {NestedNotesData, DEFAULT_DATA} from './types';
import {NestedNotesSettingTab} from './settings';

export default class NestedNotesPlugin extends Plugin {
	data!: NestedNotesData;

	/** Called by Obsidian when the plugin is enabled. Registers the view, ribbon icon, command, and vault event listeners. */
	async onload(): Promise<void> {

		await this.loadPluginData();

		this.registerView(VIEW_TYPE, (leaf) => new NestedNotesView(leaf, this));

		this.addSettingTab(new NestedNotesSettingTab(this.app, this));

		this.addCommand({
			id: 'open-nested-notes-view',
			name: 'Open Nested Notes view',
			callback: () => this.activateView(), 
		});

		this.registerEvent(
			this.app.vault.on('create', (file: TAbstractFile) => {
				if (file instanceof TFile) this.refreshView();
			})
		);

		this.app.workspace.onLayoutReady(() => this.activateView());
	}

	/** Called by Obsidian when the plugin is disabled. Removes the custom view from all leaves. */
	onunload(): void {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE);
	}

	/** Opens the Nested Notes panel in the left sidebar, or reveals it if already open. */
	async activateView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		const first = existing[0];
		if (first) {
			this.app.workspace.revealLeaf(first);
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
		const saved = await this.loadData() as Partial<NestedNotesData> | null;
		this.data = Object.assign({}, DEFAULT_DATA, saved);
		// Ensure arrays are always present
		if (!this.data.children) this.data.children = {};
		if (!this.data.collapsed) this.data.collapsed = [];
	}

	/** Persists the current plugin data to data.json. */
	async savePluginData(): Promise<void> {
		// Sort each parent's children array alphabetically by basename
		for (const parentPath of Object.keys(this.data.children)) {
			const arr = this.data.children[parentPath];
			if (!arr) continue;
			arr.sort((a, b) => {
				const nameA = a.split('/').pop() ?? a;
				const nameB = b.split('/').pop() ?? b;
				return nameA.localeCompare(nameB);
			});
		}

		await this.saveData(this.data);
	}

	/** Triggers a full re-render of the tree in all open Nested Notes leaves. */
	refreshView(): void {
		this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach(leaf => {
			(leaf.view as NestedNotesView).renderTree();
		});
	}
}
