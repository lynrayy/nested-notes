import {App, PluginSettingTab, Setting} from 'obsidian';
import type NestedNotesPlugin from './main';

/** Minimal shape of the declarative settings definition used by Obsidian 1.13+. */
interface SettingDefinition {
	id: string;
	title?: string;
	name?: string;
	description?: string;
	type: string;
	get: () => unknown;
	set: (value: unknown) => void | Promise<void>;
}

export class NestedNotesSettingTab extends PluginSettingTab {
	plugin: NestedNotesPlugin;

	constructor(app: App, plugin: NestedNotesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/** Declarative settings so they appear in Obsidian's settings search (1.13+). */
	getSettingDefinitions(): SettingDefinition[] {
		return [
			{
				id: 'showFileIcon',
				title: 'Show icons',
				description: 'Display a page icon beside each note: a document icon when it has nested notes, a file icon otherwise.',
				type: 'boolean',
				get: () => this.plugin.data.showFileIcon,
				set: async (value) => {
					this.plugin.data.showFileIcon = Boolean(value);
					await this.plugin.savePluginData();
					this.plugin.refreshView();
				},
			},
			{
				id: 'showFolderPath',
				title: 'Show folder path',
				description: 'Display the folder path before the note name.',
				type: 'boolean',
				get: () => this.plugin.data.showFolderPath,
				set: async (value) => {
					this.plugin.data.showFolderPath = Boolean(value);
					await this.plugin.savePluginData();
					this.plugin.refreshView();
				},
			},
		];
	}

	/** Builds the settings UI. */
	display(): void {
		const {containerEl} = this;
		containerEl.empty();
		
		/** Show icon setting */
		new Setting(containerEl)
			.setName('Show icons')
			.setDesc('Display a page icon beside each note: a document icon when it has nested notes, a file icon otherwise.')
			.addToggle(toggle => {
				toggle.setValue(this.plugin.data.showFileIcon);
				toggle.onChange(async (value) => {
					this.plugin.data.showFileIcon = value;
					await this.plugin.savePluginData();
					this.plugin.refreshView();
				});
			});

		/** Show folder path setting */	
		new Setting(containerEl)
			.setName('Show folder path')
			.setDesc('Display the folder path before the note name.')
			.addToggle(toggle => {
				toggle.setValue(this.plugin.data.showFolderPath);
				toggle.onChange(async (value) => {
					this.plugin.data.showFolderPath = value;
					await this.plugin.savePluginData();
					this.plugin.refreshView();
				});
			});
	}
}
