import {App, PluginSettingTab, Setting} from 'obsidian';
import type NestedNotesPlugin from './main';

export class NestedNotesSettingTab extends PluginSettingTab {
	plugin: NestedNotesPlugin;

	constructor(app: App, plugin: NestedNotesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/** Builds the settings UI. */
	display(): void {
		const {containerEl} = this;
		containerEl.empty();
		
		/** Show file icon setting */
		new Setting(containerEl)
			.setName('Show file icon')
			.setDesc('Display the file icon beside each note, matching the icon shown in the files view.')
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
