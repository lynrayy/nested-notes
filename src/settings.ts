import {App, PluginSettingTab, SettingDefinitionItem} from 'obsidian';
import type NestedNotesPlugin from './main';

export class NestedNotesSettingTab extends PluginSettingTab {
	plugin: NestedNotesPlugin;

	constructor(app: App, plugin: NestedNotesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/** Declarative settings so Obsidian renders them and indexes them for search (1.13+). */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'Show icons',
				desc: 'Display a page icon beside each note: a document icon when it has nested notes, a file icon otherwise.',
				control: {type: 'toggle', key: 'showFileIcon'},
			},
			{
				name: 'Show folder path',
				desc: 'Display the path before the note name.',
				control: {type: 'toggle', key: 'showFolderPath'},
			},
		];
	}

	/** Reads a setting value from this plugin's data store. */
	getControlValue(key: string): unknown {
		return (this.plugin.data as unknown as Record<string, unknown>)[key];
	}

	/** Persists a setting value to this plugin's data store and refreshes the view. */
	async setControlValue(key: string, value: unknown): Promise<void> {
		(this.plugin.data as unknown as Record<string, unknown>)[key] = value;
		await this.plugin.savePluginData();
		this.plugin.refreshView();
	}
}
