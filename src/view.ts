import {ItemView, Menu, TFile, WorkspaceLeaf, setIcon} from 'obsidian';
import type NestedNotesPlugin from './main';

export const VIEW_TYPE = 'nested-notes-view';

export class NestedNotesView extends ItemView {
	plugin: NestedNotesPlugin;
	private draggedPath: string | null = null;
	private dropHandled = false;

	constructor(leaf: WorkspaceLeaf, plugin: NestedNotesPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	/** Returns the unique identifier for this view type. */
	getViewType(): string {
		return VIEW_TYPE;
	}

	/** Returns the display name shown in the view header. */
	getDisplayText(): string {
		return 'Nested Notes';
	}

	/** Returns the icon shown in the tab for this view. */
	getIcon(): string {
		return 'list-tree';
	}

	/** Called when the view is first opened; triggers the initial tree render. */
	async onOpen(): Promise<void> {

		/** Blank-space right-click: note rows stop propagation, so only true blank-space  */
		this.registerDomEvent(this.contentEl, 'contextmenu', (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			const menu = new Menu();
			menu.addItem(item =>
				item.setTitle('New note')
					.setIcon('file-plus')
					.onClick(async () => {
						// Resolve the folder where Obsidian is configured to put new files
						const folder = this.app.fileManager.getNewFileParent('');
						const base = folder.path === '/' || folder.path === '' ? '' : folder.path + '/';

						// Find a unique "Untitled" filename
						let name = 'Untitled';
						let counter = 1;
						while (this.app.vault.getAbstractFileByPath(`${base}${name}.md`)) {
							name = `Untitled ${counter++}`;
						}

						const file = await this.app.vault.create(`${base}${name}.md`, '');
						await this.app.workspace.getLeaf(false).openFile(file);

						await (this.app.fileManager as any).promptForFileRename(file)
					})
			);
			menu.showAtMouseEvent(e);
		});

		// Drag-and-drop onto blank space: promote to top-level
		this.registerDomEvent(this.contentEl, 'dragover', (e: DragEvent) => {
			e.preventDefault();
			e.stopPropagation(); 
		});
		this.registerDomEvent(this.contentEl, 'drop', (e: DragEvent) => {
			e.preventDefault();
			e.stopPropagation(); 
			if (this.dropHandled) {
				this.dropHandled = false;
				return;
			}
			const dragged = e.dataTransfer?.getData('text/plain') ?? this.draggedPath;
			
			if (!dragged) return;
			this.promoteToTopLevel(dragged);
		});

		
		// Vault event listeners: renamed, deleted, or created
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				// Update parent key if the renamed file was a parent
				if (this.plugin.data.children[oldPath]) {
					this.plugin.data.children[file.path] = this.plugin.data.children[oldPath];
					delete this.plugin.data.children[oldPath];
				}

				// Update child references if the renamed file was a child of any parent
				for (const parentPath of Object.keys(this.plugin.data.children)) {
					const arr = this.plugin.data.children[parentPath];
					if (!arr) continue; // ← add this guard
					const idx = arr.indexOf(oldPath);
					if (idx >= 0) {
						arr[idx] = file.path;
					}
				}

				// Update collapsed list if it was there
				const collapsedIdx = this.plugin.data.collapsed.indexOf(oldPath);
				if (collapsedIdx >= 0) {
					this.plugin.data.collapsed[collapsedIdx] = file.path;
				}

				this.plugin.savePluginData();
				this.renderTree();
			})
		);

		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				const deletedPath = file.path;

				// Find the children of the deleted note
				const orphans = this.plugin.data.children[deletedPath] ?? [];

				// Find the deleted note's own parent (if any)
				let grandparentPath: string | null = null;
				for (const parentPath of Object.keys(this.plugin.data.children)) {
					const arr = this.plugin.data.children[parentPath];
            		if (!arr) continue; // ← guard
					if (arr.includes(deletedPath)) {
						grandparentPath = parentPath;
						break;
					}
				}

				// Remove the deleted note from its parent's children list
				if (grandparentPath) {
					const arr = this.plugin.data.children[grandparentPath];
					if (arr) {
						const idx = arr.indexOf(deletedPath);
						if (idx >= 0) arr.splice(idx, 1);
						arr.push(...orphans);
						if (arr.length === 0) delete this.plugin.data.children[grandparentPath];
					}
				}
				// else: deleted note was top-level, orphans just become top-level (no action needed)

				// Remove the deleted note's own children entry
				delete this.plugin.data.children[deletedPath];

				// Remove from collapsed list
				const collapsedIdx = this.plugin.data.collapsed.indexOf(deletedPath);
				if (collapsedIdx >= 0) {
					this.plugin.data.collapsed.splice(collapsedIdx, 1);
				}

				this.plugin.savePluginData();
				this.renderTree();
			})
		);

		this.registerEvent(
			this.app.vault.on('create', () => this.renderTree())
		);

		this.renderTree();
	}

	/** Called when the view is closed; clears the DOM. */
	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	/** Clears and fully re-renders the note tree from current vault state and plugin data. */
	renderTree(): void {
		this.contentEl.empty();

		const container = this.contentEl.createDiv({cls: 'cn-container'});
		const allFiles = this.app.vault.getMarkdownFiles();

		if (allFiles.length === 0) {
			container.createDiv({cls: 'cn-empty', text: 'No notes found.'});
			return;
		}

		// Collect all paths that are children of something
		const childPaths = new Set<string>();
		for (const key of Object.keys(this.plugin.data.children)) {
			const paths = this.plugin.data.children[key] ?? [];
			for (const p of paths) childPaths.add(p);
		}

		// Top-level notes: not a child of any other note
		const topLevel = allFiles
			.filter(f => !childPaths.has(f.path))
			.sort((a, b) => a.basename.localeCompare(b.basename));

		for (const file of topLevel) {
			this.renderNote(file, container);
		}
	}

	/**
	 * Renders a single note row and, if expanded, recursively renders its children beneath it.
	 * Attaches click, context menu, and all drag-and-drop event handlers to the row.
	 */
	private renderNote(file: TFile, container: HTMLElement): void {
		const {data} = this.plugin;
		const children = data.children[file.path] ?? [];
		const isCollapsed = data.collapsed.includes(file.path);

		// Row
		const row = container.createDiv({
			cls: 'cn-note-row',
			attr: {'draggable': 'true', 'data-path': file.path},
		});

		// Collapse toggle or spacer
		if (children.length > 0) {
			const toggle = row.createSpan({cls: 'cn-toggle'});
			setIcon(toggle, isCollapsed ? 'chevron-right' : 'chevron-down');
			toggle.addEventListener('click', (e) => {
				e.stopPropagation();
				this.toggleCollapse(file.path);
			});
		} else {
			row.createSpan({cls: 'cn-toggle-spacer'});
		}

		// File icon 
		if (this.plugin.data.showFileIcon) {
			const iconSpan = row.createSpan({cls: 'cn-icon'});
			const nativeSvg = document
				.querySelector(`.nav-file-title[data-path="${CSS.escape(file.path)}"] svg`);
			if (nativeSvg) {
				iconSpan.appendChild(nativeSvg.cloneNode(true));
			} else {
				setIcon(iconSpan, 'file');
			}
		}

		// Note name, with optional folder path prefix
		const nameWrap = row.createSpan({cls: 'cn-name'});
		if (this.plugin.data.showFolderPath) {
			const folderPath = file.parent?.path;
			if (folderPath && folderPath !== '/' && folderPath !== '') {
				nameWrap.createSpan({cls: 'cn-folder-path', text: folderPath + '/'});
			}
		}
		nameWrap.createSpan({text: file.basename});

		// Open note on click
		row.addEventListener('click', async () => {
			const leaf = this.app.workspace.getLeaf(false);
			await leaf.openFile(file);
		});

		// Context menu on right-click
		row.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			e.stopPropagation();
			
			const menu = new Menu();

			// Trigger the standard file-explorer menu (gives image 2's items)
			this.app.workspace.trigger('file-menu', menu, file, 'file-explorer', this.leaf);
			
			// Manually add the items that only appear when file is "active"
			menu.addSeparator();
			menu.addItem(item => item
				.setTitle('Open in new tab')
				.setIcon('file-plus')
				.onClick(() => this.app.workspace.getLeaf('tab').openFile(file))
			);
			menu.addItem(item => item
				.setTitle('Rename...')
				.setIcon('pencil')
				.onClick(() => (this.app.fileManager as any).promptForFileRename(file))
			);
			menu.addItem(item => item
				.setTitle('Delete')
				.setIcon('trash')
				.onClick(() => this.app.vault.trash(file, true))
			);

			menu.showAtMouseEvent(e);
		});

		// Drag start: record the dragged path and suppress Obsidian's workspace drag handler
		row.addEventListener('dragstart', (e) => {
			e.stopPropagation();
			this.draggedPath = file.path;
			e.dataTransfer?.setData('text/plain', file.path);
			row.style.opacity = '0.5';
		});

		// Drag end: restore opacity and clear the tracked dragged path
		row.addEventListener('dragend', () => {
			row.style.opacity = '';
			this.draggedPath = null;
		});

		// Drag over: highlight this row as a valid drop target (skips self and own descendants)
		row.addEventListener('dragover', (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (this.draggedPath && this.draggedPath !== file.path && !this.isDescendant(file.path, this.draggedPath)) {
				row.classList.add('cn-drag-over');
			}
		});

		// Drag leave: remove highlight only when the cursor truly leaves the row (not when entering a child element)
		row.addEventListener('dragleave', (e) => {
			const related = e.relatedTarget as Node | null;
			if (!related || !row.contains(related)) {
				row.classList.remove('cn-drag-over');
			}
		});

		// Drop: nest the dragged note under this note
		row.addEventListener('drop', (e) => {
			e.preventDefault();
			row.classList.remove('cn-drag-over');
			const dragged = e.dataTransfer?.getData('text/plain') ?? this.draggedPath;
			if (!dragged || dragged === file.path) return;
			if (this.isDescendant(file.path, dragged)) return;
			this.nestNote(dragged, file.path);
    		this.dropHandled = true; 
		});

		// Render children if expanded
		if (children.length > 0 && !isCollapsed) {
			const childContainer = container.createDiv({cls: 'cn-children'});
			for (const childPath of children) {
				const childFile = this.app.vault.getAbstractFileByPath(childPath);
				if (childFile instanceof TFile) {
					this.renderNote(childFile, childContainer);
				}
			}
		}
	}

	/** Removes a note from any parent, making it top-level. */
	private promoteToTopLevel(path: string): void {
		for (const parentPath of Object.keys(this.plugin.data.children)) {
			const arr = this.plugin.data.children[parentPath];
			if (!arr) continue;
			const idx = arr.indexOf(path);
			if (idx >= 0) {
				arr.splice(idx, 1);
				if (arr.length === 0) delete this.plugin.data.children[parentPath];
				break;
			}
		}
		console.log(`Promoted ${path} to top-level`);
		this.plugin.savePluginData();
		this.renderTree();
	}

	/** Toggles the collapsed state of a note, saves, and re-renders the tree. */
	private toggleCollapse(path: string): void {
		const idx = this.plugin.data.collapsed.indexOf(path);
		if (idx >= 0) {
			this.plugin.data.collapsed.splice(idx, 1);
		} else {
			this.plugin.data.collapsed.push(path);
		}
		this.plugin.savePluginData();
		this.renderTree();
	}

	/** Makes childPath a sub-note of parentPath, removing it from any previous parent first. */
	private nestNote(childPath: string, parentPath: string): void {
		// Remove child from any existing parent
		for (const key of Object.keys(this.plugin.data.children)) {
			const arr = this.plugin.data.children[key];
			if (!arr) continue;
			const i = arr.indexOf(childPath);
			if (i >= 0) {
				arr.splice(i, 1);
				if (arr.length === 0) delete this.plugin.data.children[key];
			}
		}

		// Add child to new parent
		if (!this.plugin.data.children[parentPath]) {
			this.plugin.data.children[parentPath] = [];
		}
		this.plugin.data.children[parentPath].push(childPath);

		this.plugin.savePluginData();
		this.renderTree();
	}

	/** Returns true if targetPath appears anywhere in the subtree rooted at ancestorPath. */
	private isDescendant(targetPath: string, ancestorPath: string): boolean {
		const children = this.plugin.data.children[ancestorPath] ?? [];
		for (const child of children) {
			if (child === targetPath) return true;
			if (this.isDescendant(targetPath, child)) return true;
		}
		return false;
	}
}
