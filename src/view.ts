import {
	App,
	ItemView,
	Menu,
	Modal,
	Notice,
	TAbstractFile,
	TFile,
	TFolder,
	WorkspaceLeaf,
	normalizePath,
	setIcon,
} from 'obsidian';
import type NestedNotesPlugin from './main';

interface NoteNode {
	file: TFile;
	folder: TFolder | null;
	children: NoteNode[];
}

/** A single entry in Obsidian's core Bookmarks plugin (partial shape). */
interface BookmarkItem {
	type: string;
	path?: string;
	title?: string;
	items?: BookmarkItem[];
	[key: string]: unknown;
}

/** Minimal shape of Obsidian's core Bookmarks plugin instance. */
interface BookmarksPluginInstance {
	items: BookmarkItem[];
	addItem(item: BookmarkItem): void;
	removeItem(item: BookmarkItem): void;
}

type SubmitNoteName = (name: string) => Promise<void>;

type DropMode = 'before' | 'after' | 'nest';

const CHILD_LINKS_CALLOUT = '> [!nested-notes]+ Pages inside';
const LEGACY_CHILD_LINKS_START = '<!-- nested-notes:children:start -->';
const LEGACY_CHILD_LINKS_END = '<!-- nested-notes:children:end -->';

const ORDER_PREFIX_RE = /^(\d+)\s+(.*)$/;

export const VIEW_TYPE = 'nested-notes-view';

class NoteNameModal extends Modal {
	private readonly initialName: string;
	private readonly onSubmitName: SubmitNoteName;
	private inputEl: HTMLInputElement | null = null;

	constructor(app: App, initialName: string, onSubmitName: SubmitNoteName) {
		super(app);
		this.initialName = initialName;
		this.onSubmitName = onSubmitName;
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.empty();
		contentEl.createEl('h2', {text: 'Rename note'});

		const inputEl = contentEl.createEl('input', {
			cls: 'nested-notes-rename-input',
			attr: {type: 'text'},
		});
		inputEl.value = this.initialName;
		this.inputEl = inputEl;

		const buttonRow = contentEl.createDiv({cls: 'nested-notes-rename-actions'});
		const cancelButton = buttonRow.createEl('button', {text: 'Cancel'});
		const renameButton = buttonRow.createEl('button', {
			text: 'Rename',
			cls: 'mod-cta',
		});

		cancelButton.addEventListener('click', () => this.close());
		renameButton.addEventListener('click', () => {
			void this.submit();
		});
		inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				void this.submit();
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				this.close();
			}
		});

		window.setTimeout(() => {
			inputEl.focus();
			inputEl.select();
		});
	}

	private async submit(): Promise<void> {
		const value = this.inputEl?.value.trim() ?? '';
		if (!value) return;

		try {
			await this.onSubmitName(value);
			this.close();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(message);
		}
	}
}

export class NestedNotesView extends ItemView {
	plugin: NestedNotesPlugin;
	private draggedPath: string | null = null;
	private dropHandled = false;
	private dropRow: HTMLElement | null = null;
	private dropMode: DropMode | null = null;
	private suppressDepth = 0;
	private activeFilePath: string | null = null;
	private activeMenu: Menu | null = null;
	private activeMenuPath: string | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: NestedNotesPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Nested notes';
	}

	getIcon(): string {
		return 'list-tree';
	}

	async onOpen(): Promise<void> {
		this.registerDomEvent(this.contentEl, 'contextmenu', (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			this.hideActiveMenu();

			const menu = new Menu();
			menu.addItem(item =>
				item.setTitle('New note')
					.setIcon('file-plus')
					.onClick(() => {
						void this.runBatched(() => this.createTopLevelNote());
					})
			);
			menu.showAtMouseEvent(e);
		});

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

			const dragged = this.draggedPath ?? e.dataTransfer?.getData('text/plain');
			if (!dragged) return;
			void this.runBatched(() => this.promoteToTopLevel(dragged));
		});

		this.registerEvent(
			this.app.vault.on('create', () => {
				if (this.suppressDepth > 0) return;
				void this.handleVaultStructureChange();
			})
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (this.suppressDepth > 0) return;
				void this.handleExternalRename(file, oldPath);
			})
		);
		this.registerEvent(
			this.app.vault.on('delete', () => {
				if (this.suppressDepth > 0) return;
				void this.handleVaultStructureChange();
			})
		);

		this.registerEvent(
			this.app.workspace.on('file-open', (file) => {
				this.activeFilePath = file ? file.path : null;
				this.renderTree();
			})
		);

		await this.runBatched(async () => {
			await this.migrateLegacyChildren();
			await this.migrateNoteFileIndices();
			await this.cleanupTempFolders();
			await this.syncAllChildLinkBlocks();
		});
		this.activeFilePath = this.app.workspace.getActiveFile()?.path ?? null;
		this.renderTree();
	}

	async onClose(): Promise<void> {
		this.hideActiveMenu();
		this.contentEl.empty();
	}

	renderTree(): void {
		this.contentEl.empty();

		const container = this.contentEl.createDiv({cls: 'cn-container'});
		const topLevel = this.buildNoteTree();

		if (topLevel.length === 0) {
			container.createDiv({cls: 'cn-empty', text: 'No notes found.'});
			return;
		}

		for (const node of topLevel) {
			this.renderNote(node, container);
		}
	}

	private renderNote(node: NoteNode, container: HTMLElement): void {
		const {file, children} = node;
		const isCollapsed = this.plugin.data.collapsed.includes(file.path);

		const row = container.createDiv({
			cls: this.activeFilePath === file.path ? 'cn-note-row cn-active' : 'cn-note-row',
			attr: {'draggable': 'true', 'data-path': file.path},
		});

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

		if (this.plugin.data.showFileIcon) {
			const iconSpan = row.createSpan({cls: 'cn-icon'});
			setIcon(iconSpan, children.length > 0 ? 'file-text' : 'file');
		}

		const nameWrap = row.createSpan({cls: 'cn-name'});
		if (this.plugin.data.showFolderPath) {
			const folderPath = file.parent?.path;
			if (folderPath && folderPath !== '/' && folderPath !== '') {
				const displayPath = folderPath
					.split('/')
					.map(segment => this.stripOrderPrefix(segment))
					.join('/');
				nameWrap.createSpan({cls: 'cn-folder-path', text: `${displayPath}/`});
			}
		}
		nameWrap.createSpan({text: this.displayBasename(file)});

		const actions = row.createSpan({cls: 'cn-actions'});

		const menuButton = actions.createEl('button', {
			cls: 'cn-note-action',
			attr: {
				'aria-label': 'More options',
				'title': 'More options',
				'type': 'button',
				'draggable': 'false',
			},
		});
		setIcon(menuButton, 'more-horizontal');
		menuButton.addEventListener('mousedown', (e) => e.stopPropagation());
		menuButton.addEventListener('click', (e) => {
			this.showNoteContextMenu(file, e, true);
		});

		const addButton = actions.createEl('button', {
			cls: 'cn-note-action',
			attr: {
				'aria-label': 'New nested note',
				'title': 'New nested note',
				'type': 'button',
				'draggable': 'false',
			},
		});
		setIcon(addButton, 'plus');
		addButton.addEventListener('mousedown', (e) => e.stopPropagation());
		addButton.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			void this.runBatched(() => this.createNestedNote(file));
		});

		row.addEventListener('click', () => {
			void this.openNote(file);
		});
		row.addEventListener('contextmenu', (e) => {
			this.showNoteContextMenu(file, e);
		});

		row.addEventListener('dragstart', (e) => {
			e.stopPropagation();
			this.draggedPath = file.path;
			this.dropHandled = false;
			// For drops into a note's text, expose a markdown link that shows
			// only the note name instead of the full vault path.
			e.dataTransfer?.setData('text/plain', this.getDragLinkText(file));
			row.classList.add('cn-dragging');
		});
		row.addEventListener('dragend', () => {
			row.classList.remove('cn-dragging');
			this.clearDropIndicator();
			this.draggedPath = null;
			this.dropHandled = false;
		});
		row.addEventListener('dragover', (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (!this.draggedPath || this.draggedPath === file.path) {
				this.clearDropIndicator();
				return;
			}
			if (this.wouldMoveIntoSelf(this.draggedPath, file)) {
				this.clearDropIndicator();
				return;
			}

			const rect = row.getBoundingClientRect();
			const ratio = (e.clientY - rect.top) / rect.height;
			const mode: DropMode = ratio < 0.4 ? 'before' : ratio > 0.6 ? 'after' : 'nest';

			this.setDropIndicator(row, mode);
		});
		row.addEventListener('dragleave', (e) => {
			const related = e.relatedTarget as Node | null;
			if (related && !row.contains(related)) {
				this.clearDropIndicator();
			}
		});
		row.addEventListener('drop', (e) => {
			e.preventDefault();
			e.stopPropagation();
			const mode = this.dropMode;
			this.clearDropIndicator();
			const dragged = this.draggedPath ?? e.dataTransfer?.getData('text/plain');
			if (!dragged || dragged === file.path) return;
			if (this.wouldMoveIntoSelf(dragged, file)) return;
			if (mode === 'nest' || !mode) {
				void this.runBatched(() => this.nestNote(dragged, file));
			} else {
				void this.runBatched(() => this.insertNoteRelative(dragged, file, mode));
			}
			this.dropHandled = true;
		});

		if (children.length > 0 && !isCollapsed) {
			const childContainer = container.createDiv({cls: 'cn-children'});
			for (const child of children) {
				this.renderNote(child, childContainer);
			}
		}
	}

	private buildNoteTree(): NoteNode[] {
		const canonicalNodes = new Map<string, NoteNode>();
		const looseNodes: NoteNode[] = [];

		for (const file of this.app.vault.getFiles()) {
			// A canonical note is identified by its markdown main file. Every
			// other file (including notes created outside the plugin and other
			// Obsidian data formats) is treated as a loose file so it still
			// shows up in the hierarchy.
			const folder = file.extension === 'md' ? this.getCanonicalNoteFolder(file) : null;
			if (folder) {
				canonicalNodes.set(folder.path, {file, folder, children: []});
				continue;
			}

			looseNodes.push({file, folder: null, children: []});
		}

		const topLevel: NoteNode[] = [];
		for (const node of canonicalNodes.values()) {
			const parentFolder = node.folder?.parent;
			const parentNode = parentFolder ? canonicalNodes.get(parentFolder.path) : null;
			if (parentNode && parentNode !== node) {
				parentNode.children.push(node);
			} else {
				topLevel.push(node);
			}
		}

		for (const node of looseNodes) {
			const parentNode = this.nearestCanonicalAncestor(node.file, canonicalNodes);
			if (parentNode) {
				parentNode.children.push(node);
			} else {
				topLevel.push(node);
			}
		}

		this.sortNodes(topLevel);
		return topLevel;
	}

	private sortNodes(nodes: NoteNode[]): void {
		nodes.sort((a, b) => {
			const ak = this.nodeOrderKey(a);
			const bk = this.nodeOrderKey(b);
			if (ak !== bk) return ak - bk;
			return this.nodeSortName(a).localeCompare(this.nodeSortName(b));
		});
		for (const node of nodes) {
			this.sortNodes(node.children);
		}
	}

	private nodeOrderKey(node: NoteNode): number {
		return this.parseOrderIndex(this.nodeSortName(node)) ?? Number.MAX_SAFE_INTEGER;
	}

	private nodeSortName(node: NoteNode): string {
		return node.folder ? node.folder.name : node.file.basename;
	}

	private nearestCanonicalAncestor(file: TFile, canonicalNodes: Map<string, NoteNode>): NoteNode | null {
		let folder = file.parent;
		while (folder && !folder.isRoot()) {
			const node = canonicalNodes.get(folder.path);
			if (node) return node;
			folder = folder.parent;
		}
		return null;
	}

	private async createTopLevelNote(): Promise<void> {
		const parentFolder = this.app.fileManager.getNewFileParent('');
		const parentPath = this.folderPath(parentFolder);
		const file = await this.createNoteInFolder(parentPath, 'Untitled');
		await this.openNote(file);
		this.promptForNoteRename(file);
		await this.renumberSiblings(parentPath);
		await this.syncAllChildLinkBlocks();
		this.renderTree();
	}

	private async createNestedNote(parentFile: TFile): Promise<void> {
		const parentFolder = await this.ensureCanonicalNoteFolder(parentFile);
		const file = await this.createNoteInFolder(parentFolder.path, 'Untitled');
		await this.openNote(file);
		this.promptForNoteRename(file);
		await this.renumberSiblings(parentFolder.path);
		await this.syncAllChildLinkBlocks();
		this.renderTree();
	}

	private async createNoteInFolder(parentFolderPath: string, preferredName: string): Promise<TFile> {
		const folderPath = this.getAvailableFolderPath(parentFolderPath, preferredName);
		await this.ensureFolder(folderPath);

		const filePath = this.joinPath(folderPath, this.mainNoteFileName(folderPath));
		return await this.app.vault.create(filePath, '');
	}

	private async openNote(file: TFile): Promise<void> {
		await this.app.workspace.getLeaf(false).openFile(file);
	}

	private promptForNoteRename(file: TFile): void {
		new NoteNameModal(this.app, this.displayBasename(file), async (name) => {
			await this.runBatched(() => this.renameNote(file, name));
		}).open();
	}

	private showNoteContextMenu(file: TFile, e: MouseEvent, toggle = false): void {
		e.preventDefault();
		e.stopPropagation();

		if (toggle && this.activeMenu && this.activeMenuPath === file.path) {
			this.hideActiveMenu();
			return;
		}

		this.hideActiveMenu();

		const menu = new Menu();
		this.activeMenu = menu;
		this.activeMenuPath = file.path;
		menu.onHide(() => {
			if (this.activeMenu === menu) {
				this.activeMenu = null;
				this.activeMenuPath = null;
			}
		});

		menu.addItem(item => item
			.setTitle('Open')
			.setIcon('file-text')
			.onClick(() => {
				void this.openNote(file);
			})
		);
		menu.addItem(item => item
			.setTitle('Open in new tab')
			.setIcon('file-plus')
			.onClick(() => {
				void this.app.workspace.getLeaf('tab').openFile(file);
			})
		);
		menu.addSeparator();
		menu.addItem(item => item
			.setTitle('Move up')
			.setIcon('arrow-up')
			.onClick(() => {
				void this.runBatched(() => this.reorderNote(file, 'up'));
			})
		);
		menu.addItem(item => item
			.setTitle('Move down')
			.setIcon('arrow-down')
			.onClick(() => {
				void this.runBatched(() => this.reorderNote(file, 'down'));
			})
		);
		menu.addSeparator();
		menu.addItem(item => item
			.setTitle('Copy link to note')
			.setIcon('link')
			.onClick(() => this.copyNoteLink(file))
		);
		menu.addItem(item => item
			.setTitle('Duplicate note')
			.setIcon('copy')
			.onClick(() => {
				void this.runBatched(() => this.duplicateNote(file));
			})
		);
		const isBookmarked = this.isBookmarked(file);
		menu.addItem(item => item
			.setTitle(isBookmarked ? 'Remove from bookmarks' : 'Add to bookmarks')
			.setIcon(isBookmarked ? 'bookmark-minus' : 'bookmark')
			.onClick(() => this.toggleBookmark(file))
		);
		menu.addSeparator();
		menu.addItem(item => item
			.setTitle('Rename...')
			.setIcon('pencil')
			.onClick(() => this.promptForNoteRename(file))
		);
		menu.addItem(item => item
			.setTitle('Delete')
			.setIcon('trash')
			.onClick(() => {
				void this.runBatched(() => this.deleteNote(file));
			})
		);

		menu.showAtMouseEvent(e);
	}

	private hideActiveMenu(): void {
		const menu = this.activeMenu;
		this.activeMenu = null;
		this.activeMenuPath = null;
		menu?.hide();
	}

	/** Copies an Obsidian internal link (`[[note name]]`) for the note. */
	private copyNoteLink(file: TFile): void {
		const link = `[[${this.displayBasename(file)}]]`;
		const clipboard = navigator.clipboard;
		if (!clipboard) {
			new Notice('Clipboard is not available.');
			return;
		}
		void clipboard.writeText(link).then(
			() => new Notice('Link copied to clipboard.'),
			() => new Notice('Could not copy link to clipboard.')
		);
	}

	private async duplicateNote(file: TFile): Promise<void> {
		const folder = this.getCanonicalNoteFolder(file);
		if (folder) {
			await this.duplicateNoteFolder(file, folder);
		} else {
			await this.duplicateLooseFile(file);
		}
	}

	/** Duplicates a canonical note by copying its folder (and all its files). */
	private async duplicateNoteFolder(file: TFile, folder: TFolder): Promise<void> {
		const parentPath = this.folderPath(folder.parent);
		const baseName = this.stripOrderPrefix(folder.name);
		const newFolderName = this.getNextDuplicateName(baseName, parentPath);
		const newFolderPath = this.joinPath(parentPath, newFolderName);
		await this.ensureFolder(newFolderPath);

		await this.copyFolderContents(folder, newFolderPath);
		// The copied main note file keeps its old name; align it with the new
		// folder name so the duplicate is a proper canonical note.
		await this.ensureMainFileMatchesFolder(newFolderPath, file.name);

		await this.renumberSiblings(parentPath);
		await this.syncAllChildLinkBlocks();
		this.renderTree();
	}

	/** Recursively copies every file and subfolder from `source` into `targetPath`. */
	private async copyFolderContents(source: TFolder, targetPath: string): Promise<void> {
		for (const child of source.children) {
			const childTarget = this.joinPath(targetPath, child.name);
			if (child instanceof TFolder) {
				await this.ensureFolder(childTarget);
				await this.copyFolderContents(child, childTarget);
			} else if (child instanceof TFile) {
				await this.app.vault.copy(child, childTarget);
			}
		}
	}

	private getNextDuplicateName(baseName: string, parentPath: string): string {
		let counter = 1;
		while (true) {
			const candidateName = `${baseName} (${counter})`;
			const candidatePath = this.joinPath(parentPath, candidateName);
			if (!this.app.vault.getAbstractFileByPath(candidatePath)) return candidateName;
			counter++;
		}
	}

	/** Duplicates a loose file (e.g. a note created outside the plugin). */
	private async duplicateLooseFile(file: TFile): Promise<void> {
		const parentPath = this.folderPath(file.parent);
		const baseName = file.basename;
		const extension = file.extension;
		let counter = 1;
		let targetPath = '';
		while (true) {
			const candidateName = `${baseName} (${counter}).${extension}`;
			targetPath = this.joinPath(parentPath, candidateName);
			if (!this.app.vault.getAbstractFileByPath(targetPath)) break;
			counter++;
		}
		await this.app.vault.copy(file, targetPath);
		await this.syncAllChildLinkBlocks();
		this.renderTree();
	}

	/**
	 * Minimal shape of Obsidian's core Bookmarks plugin instance (not in the
	 * public API). `addItem`/`removeItem` persist and refresh the bookmark view.
	 */
	private getBookmarksPlugin(): BookmarksPluginInstance | null {
		const internal = (this.app as unknown as {
			internalPlugins?: {
				getEnabledPluginById(id: string): unknown;
			};
		}).internalPlugins;
		if (!internal) return null;

		const plugin = internal.getEnabledPluginById('bookmarks');
		if (
			!plugin
			|| typeof (plugin as BookmarksPluginInstance).addItem !== 'function'
			|| typeof (plugin as BookmarksPluginInstance).removeItem !== 'function'
		) {
			return null;
		}
		return plugin as BookmarksPluginInstance;
	}

	/** True when the file is already present in Obsidian's native bookmarks. */
	private isBookmarked(file: TFile): boolean {
		const plugin = this.getBookmarksPlugin();
		if (!plugin) return false;
		return this.findNativeBookmark(plugin.items, file.path) !== null;
	}

	private findNativeBookmark(items: BookmarkItem[], path: string): BookmarkItem | null {
		for (const item of items) {
			if (item.type === 'file' && item.path === path) return item;
			if (Array.isArray(item.items)) {
				const found = this.findNativeBookmark(item.items, path);
				if (found) return found;
			}
		}
		return null;
	}

	private toggleBookmark(file: TFile): void {
		const plugin = this.getBookmarksPlugin();
		if (!plugin) {
			new Notice('Enable the bookmarks core plugin to bookmark notes.');
			return;
		}

		const existing = this.findNativeBookmark(plugin.items, file.path);
		if (existing) {
			plugin.removeItem(existing);
		} else {
			plugin.addItem({type: 'file', path: file.path});
		}
		this.renderTree();
	}

	private async renameNote(file: TFile, name: string): Promise<void> {
		const canonicalFile = await this.ensureCanonicalNoteFile(file);
		const folder = this.getCanonicalNoteFolder(canonicalFile);
		if (!folder) throw new Error('Could not resolve note folder.');

		const newName = this.sanitizeNoteName(name);
		const existingIndex = this.parseOrderIndex(folder.name);
		const newFolderName = existingIndex !== null
			? this.formatOrderName(existingIndex, newName)
			: newName;
		const parentPath = this.folderPath(folder.parent);
		const targetFolderPath = this.getAvailableFolderPath(parentPath, newFolderName, folder.path);

		if (targetFolderPath !== folder.path) {
			await this.app.fileManager.renameFile(folder, targetFolderPath);
		}

		// The folder keeps the order index, the file only gets the plain name.
		await this.ensureMainFileMatchesFolder(targetFolderPath, canonicalFile.name);

		// (Re)assign order indices to the siblings so a note that had no index
		// (e.g. a freshly created one) gets one and manual ordering keeps working.
		await this.renumberSiblings(parentPath);

		await this.syncAllChildLinkBlocks();
		this.renderTree();
	}

	private async deleteNote(file: TFile): Promise<void> {
		const folder = this.getCanonicalNoteFolder(file);
		const parentPath = folder ? this.folderPath(folder.parent) : '';

		await this.app.fileManager.trashFile(folder ?? file);
		await this.renumberSiblings(parentPath);
		await this.syncAllChildLinkBlocks();
		this.renderTree();
	}

	private async promoteToTopLevel(path: string): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return;

		const sourceFolder = this.getCanonicalNoteFolder(file);
		const sourceParent = sourceFolder ? this.folderPath(sourceFolder.parent) : '';
		const topLevelParent = this.app.fileManager.getNewFileParent('');
		const targetParent = this.folderPath(topLevelParent);
		await this.moveNoteToParentFolder(file, targetParent);
		if (sourceParent && sourceParent !== targetParent) {
			await this.renumberSiblings(sourceParent);
		}
		await this.renumberSiblings(targetParent);
		await this.syncAllChildLinkBlocks();
		this.renderTree();
	}

	private async nestNote(childPath: string, parentFile: TFile): Promise<void> {
		const childFile = this.app.vault.getFileByPath(childPath);
		if (!childFile) return;

		const childFolder = this.getCanonicalNoteFolder(childFile);
		const childParent = childFolder ? this.folderPath(childFolder.parent) : '';

		const parentFolder = await this.ensureCanonicalNoteFolder(parentFile);
		await this.moveNoteToParentFolder(childFile, parentFolder.path);

		if (childParent && childParent !== parentFolder.path) {
			await this.renumberSiblings(childParent);
		}
		await this.renumberSiblings(parentFolder.path);

		const collapsedIdx = this.plugin.data.collapsed.indexOf(parentFile.path);
		if (collapsedIdx >= 0) {
			this.plugin.data.collapsed.splice(collapsedIdx, 1);
			await this.plugin.savePluginData();
		}

		await this.syncAllChildLinkBlocks();
		this.renderTree();
	}

	private async moveNoteToParentFolder(file: TFile, targetParentFolderPath: string): Promise<TFile> {
		const canonicalFile = await this.ensureCanonicalNoteFile(file);
		const folder = this.getCanonicalNoteFolder(canonicalFile);
		if (!folder) throw new Error('Could not resolve note folder.');

		if (this.isSameOrDescendantPath(targetParentFolderPath, folder.path)) {
			new Notice('Cannot move a note inside itself.');
			return canonicalFile;
		}

		const currentParentPath = this.folderPath(folder.parent);
		if (currentParentPath === targetParentFolderPath) return canonicalFile;

		const targetFolderPath = this.getAvailableFolderPath(targetParentFolderPath, folder.name);
		await this.app.fileManager.renameFile(folder, targetFolderPath);

		return await this.ensureMainFileMatchesFolder(targetFolderPath, canonicalFile.name);
	}

	private async ensureCanonicalNoteFolder(file: TFile): Promise<TFolder> {
		const canonicalFile = await this.ensureCanonicalNoteFile(file);
		const folder = this.getCanonicalNoteFolder(canonicalFile);
		if (!folder) throw new Error('Could not create note folder.');
		return folder;
	}

	private async ensureCanonicalNoteFile(file: TFile): Promise<TFile> {
		if (this.getCanonicalNoteFolder(file)) return file;

		const parentPath = this.folderPath(file.parent);
		const folderPath = this.getAvailableFolderPath(parentPath, file.basename);
		await this.ensureFolder(folderPath);

		const targetPath = this.joinPath(folderPath, this.mainNoteFileName(folderPath));
		if (file.path !== targetPath) {
			await this.app.fileManager.renameFile(file, targetPath);
		}
		return this.getFileOrThrow(targetPath);
	}

	private async ensureMainFileMatchesFolder(folderPath: string, currentFileName: string): Promise<TFile> {
		const expectedPath = this.joinPath(folderPath, this.mainNoteFileName(folderPath));
		const file = this.app.vault.getFileByPath(this.joinPath(folderPath, currentFileName))
			?? this.findMainNoteFile(this.app.vault.getFolderByPath(folderPath));

		if (!file) throw new Error('Could not find the note file inside its folder.');
		if (file.path === expectedPath) return file;

		await this.app.fileManager.renameFile(file, expectedPath);
		return this.getFileOrThrow(expectedPath);
	}

	private async ensureFolder(path: string): Promise<TFolder> {
		const normalizedPath = this.normalizeVaultPath(path);
		if (!normalizedPath) return this.app.vault.getRoot();

		let currentPath = '';
		for (const part of normalizedPath.split('/')) {
			currentPath = this.joinPath(currentPath, part);
			const existing = this.app.vault.getAbstractFileByPath(currentPath);
			if (existing instanceof TFolder) continue;
			if (existing) throw new Error(`Cannot create folder: ${currentPath} already exists.`);
			await this.app.vault.createFolder(currentPath);
		}

		const folder = this.app.vault.getFolderByPath(normalizedPath);
		if (!folder) throw new Error(`Could not create folder: ${normalizedPath}`);
		return folder;
	}

	/**
	 * Returns the folder that represents this note, or null when the file is not
	 * a note's main file.
	 *
	 * A folder represents a note when it contains a markdown file named after the
	 * folder with its order index stripped (`3 My note/My note.md`). Folders whose
	 * file still carries the index (`3 My note/3 My note.md`) are also accepted so
	 * that vaults created by older versions keep working before migration.
	 */
	private getCanonicalNoteFolder(file: TFile): TFolder | null {
		const folder = file.parent;
		if (!folder || folder.isRoot()) return null;
		return this.isMainNoteFileName(folder, file.basename) ? folder : null;
	}

	/** True when `basename` names the main note file of `folder`. */
	private isMainNoteFileName(folder: TFolder, basename: string): boolean {
		return basename === this.stripOrderPrefix(folder.name) || basename === folder.name;
	}

	private parseOrderIndex(name: string): number | null {
		const match = name.match(ORDER_PREFIX_RE);
		if (!match) return null;
		const value = parseInt(match[1] ?? '', 10);
		return Number.isNaN(value) ? null : value;
	}

	private stripOrderPrefix(name: string): string {
		const match = name.match(ORDER_PREFIX_RE);
		return match ? (match[2] ?? '') : name;
	}

	private formatOrderName(index: number, name: string): string {
		return `${index} ${name}`;
	}

	/**
	 * File name the main note file of `folderPath` should have: the folder name
	 * without its order index, so the index never shows up in tab titles or
	 * inline note headings.
	 */
	private mainNoteFileName(folderPath: string): string {
		return `${this.stripOrderPrefix(this.basenameFromPath(folderPath))}.md`;
	}

	/** Finds the main markdown file of a note folder, tolerating name mismatches. */
	private findMainNoteFile(folder: TFolder | null): TFile | null {
		if (!folder) return null;
		const markdownFiles = folder.children.filter(
			(child): child is TFile => child instanceof TFile && child.extension === 'md'
		);
		const strippedName = this.stripOrderPrefix(folder.name);
		return markdownFiles.find(file => file.basename === strippedName)
			?? markdownFiles.find(file => file.basename === folder.name)
			?? markdownFiles[0]
			?? null;
	}

	/**
	 * Name shown in the tree. The note's real name lives in its folder name, so
	 * the index is stripped from there; loose files are shown as-is.
	 */
	private displayBasename(file: TFile): string {
		const folder = this.getCanonicalNoteFolder(file);
		return folder ? this.stripOrderPrefix(folder.name) : file.basename;
	}

	/** Markdown link used when a note is dragged into a note's text. */
	private getDragLinkText(file: TFile): string {
		const display = this.displayBasename(file);
		const alias = file.basename === display ? undefined : display;
		const sourcePath = this.app.workspace.getActiveFile()?.path ?? '';
		return this.app.fileManager.generateMarkdownLink(file, sourcePath, undefined, alias);
	}

	private isCanonicalNoteFolder(folder: TFolder): boolean {
		return folder.children.some(
			(child): child is TFile =>
				child instanceof TFile
				&& child.extension === 'md'
				&& this.isMainNoteFileName(folder, child.basename)
		);
	}

	private getChildNoteFolders(parentFolderPath: string): TFolder[] {
		const parent = parentFolderPath
			? this.app.vault.getFolderByPath(parentFolderPath)
			: this.app.vault.getRoot();
		if (!parent) return [];
		return parent.children.filter(
			(child): child is TFolder => child instanceof TFolder && this.isCanonicalNoteFolder(child)
		);
	}

	private sortFoldersByName(folders: TFolder[]): TFolder[] {
		return [...folders].sort((a, b) => {
			const ai = this.parseOrderIndex(a.name) ?? Number.MAX_SAFE_INTEGER;
			const bi = this.parseOrderIndex(b.name) ?? Number.MAX_SAFE_INTEGER;
			if (ai !== bi) return ai - bi;
			return a.name.localeCompare(b.name);
		});
	}

	private async reorderNote(file: TFile, direction: 'up' | 'down'): Promise<void> {
		const folder = this.getCanonicalNoteFolder(file);
		if (!folder) return;

		const parentPath = this.folderPath(folder.parent);
		const siblings = this.sortFoldersByName(this.getChildNoteFolders(parentPath));
		const currentIndex = siblings.findIndex(sibling => sibling.path === folder.path);
		if (currentIndex < 0) return;

		const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
		if (targetIndex < 0 || targetIndex >= siblings.length) return;

		const [moved] = siblings.splice(currentIndex, 1);
		if (!moved) return;
		siblings.splice(targetIndex, 0, moved);

		await this.applyOrder(siblings, parentPath);
		await this.syncAllChildLinkBlocks();
		this.renderTree();
	}

	private async renumberSiblings(parentFolderPath: string): Promise<void> {
		const siblings = this.sortFoldersByName(this.getChildNoteFolders(parentFolderPath));
		if (siblings.length === 0) return;
		await this.applyOrder(siblings, parentFolderPath);
	}

	private async insertNoteRelative(draggedPath: string, targetFile: TFile, position: 'before' | 'after'): Promise<void> {
		const draggedFile = this.app.vault.getFileByPath(draggedPath);
		if (!draggedFile) return;

		const targetFolder = this.getCanonicalNoteFolder(targetFile);
		if (!targetFolder) return;
		if (this.wouldMoveIntoSelf(draggedPath, targetFile)) return;

		const targetParentPath = this.folderPath(targetFolder.parent);

		const draggedFolder = this.getCanonicalNoteFolder(draggedFile);
		const sourceParentPath = draggedFolder ? this.folderPath(draggedFolder.parent) : '';

		// Reordering within the same parent only reorders; moving across parents
		// first relocates the note to the target's parent, then positions it.
		let movedFile = draggedFile;
		if (sourceParentPath !== targetParentPath) {
			movedFile = await this.moveNoteToParentFolder(draggedFile, targetParentPath);
		}

		const movedFolder = this.getCanonicalNoteFolder(movedFile);
		if (!movedFolder) return;

		const siblings = this.sortFoldersByName(this.getChildNoteFolders(targetParentPath));
		const filtered = siblings.filter(sibling => sibling.path !== movedFolder.path);
		const targetIndex = filtered.findIndex(sibling => sibling.path === targetFolder.path);

		if (targetIndex < 0) {
			await this.renumberSiblings(targetParentPath);
		} else {
			const insertAt = position === 'before' ? targetIndex : targetIndex + 1;
			filtered.splice(insertAt, 0, movedFolder);
			await this.applyOrder(filtered, targetParentPath);
		}

		if (sourceParentPath && sourceParentPath !== targetParentPath) {
			await this.renumberSiblings(sourceParentPath);
		}

		await this.syncAllChildLinkBlocks();
		this.renderTree();
	}

	private setDropIndicator(row: HTMLElement, mode: DropMode): void {
		if (this.dropRow === row && this.dropMode === mode) return;
		this.clearDropIndicator();
		row.classList.add(
			mode === 'before' ? 'cn-insert-before'
				: mode === 'after' ? 'cn-insert-after'
					: 'cn-drag-over'
		);
		this.dropRow = row;
		this.dropMode = mode;
	}

	private clearDropIndicator(): void {
		if (this.dropRow) {
			this.dropRow.classList.remove('cn-insert-before', 'cn-insert-after', 'cn-drag-over');
		}
		this.dropRow = null;
		this.dropMode = null;
	}

	private async applyOrder(folders: TFolder[], parentFolderPath: string): Promise<void> {
		if (folders.length === 0) return;

		const tempSuffix = `__reorder_${Date.now().toString(36)}__`;
		const entries = folders.map((folder, i) => {
			const finalName = this.formatOrderName(i + 1, this.stripOrderPrefix(folder.name));
			return {
				source: folder,
				finalName,
				tempPath: this.joinPath(parentFolderPath, `${tempSuffix}${i}`),
			};
		});

		try {
			for (const entry of entries) {
				if (entry.source.path !== entry.tempPath) {
					await this.app.fileManager.renameFile(entry.source, entry.tempPath);
				}
			}

			for (const entry of entries) {
				const tempFolder = this.app.vault.getFolderByPath(entry.tempPath) ?? entry.source;
				const finalPath = this.getAvailableFolderPath(parentFolderPath, entry.finalName);
				if (tempFolder.path !== finalPath) {
					await this.app.fileManager.renameFile(tempFolder, finalPath);
				}
				await this.ensureMainFileMatchesFolder(finalPath, this.mainNoteFileName(finalPath));
			}
		} catch (error) {
			await this.cleanupTempFolders();
			throw error;
		}
	}

	private async cleanupTempFolders(): Promise<void> {
		const tempFolders = this.app.vault.getAllLoadedFiles()
			.filter((file): file is TFolder => file instanceof TFolder && /^__reorder_/.test(file.name));

		for (const folder of tempFolders) {
			const markdown = this.findMainNoteFile(folder);
			if (!markdown) continue;

			const parentPath = this.folderPath(folder.parent);
			const finalName = this.getAvailableFolderPath(parentPath, this.stripOrderPrefix(markdown.basename));
			if (finalName === folder.path) continue;

			await this.app.fileManager.renameFile(folder, finalName);
			await this.ensureMainFileMatchesFolder(finalName, markdown.name);
		}
	}

	private getAvailableFolderPath(parentFolderPath: string, preferredName: string, currentPath?: string): string {
		const baseName = this.sanitizeNoteName(preferredName);
		const normalizedCurrentPath = currentPath ? this.normalizeVaultPath(currentPath) : null;
		let candidateName = baseName;
		let counter = 1;

		while (true) {
			const candidatePath = this.joinPath(parentFolderPath, candidateName);
			if (normalizedCurrentPath && candidatePath === normalizedCurrentPath) {
				return candidatePath;
			}
			if (!this.app.vault.getAbstractFileByPath(candidatePath)) {
				return candidatePath;
			}
			candidateName = `${baseName} ${counter++}`;
		}
	}

	private wouldMoveIntoSelf(childPath: string, targetFile: TFile): boolean {
		const childFile = this.app.vault.getFileByPath(childPath);
		if (!childFile) return false;

		const childFolder = this.getCanonicalNoteFolder(childFile);
		const targetFolder = this.getCanonicalNoteFolder(targetFile);
		if (!childFolder || !targetFolder) return false;

		return this.isSameOrDescendantPath(targetFolder.path, childFolder.path);
	}

	private isSameOrDescendantPath(path: string, ancestorPath: string): boolean {
		const normalizedPath = this.normalizeVaultPath(path);
		const normalizedAncestor = this.normalizeVaultPath(ancestorPath);
		if (!normalizedAncestor) return false;
		return normalizedPath === normalizedAncestor || normalizedPath.startsWith(`${normalizedAncestor}/`);
	}

	private async handleVaultStructureChange(): Promise<void> {
		this.renderTree();
		await this.syncAllChildLinkBlocks();
		this.renderTree();
	}

	/**
	 * Keeps a note folder and its note file in sync after a rename made outside
	 * the plugin (tab title, inline title, file explorer). The folder always
	 * carries the order index, the file always carries the plain name.
	 */
	private async handleExternalRename(file: TAbstractFile, oldPath: string): Promise<void> {
		try {
			await this.runBatched(async () => {
				if (file instanceof TFile && file.extension === 'md') {
					await this.syncFolderNameWithNoteFile(file, oldPath);
				} else if (file instanceof TFolder) {
					await this.syncNoteFileNameWithFolder(file, oldPath);
				}
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(message);
		}

		await this.handleVaultStructureChange();
	}

	/** Renames the note folder after its note file was renamed in place. */
	private async syncFolderNameWithNoteFile(file: TFile, oldPath: string): Promise<void> {
		const folder = file.parent;
		if (!folder || folder.isRoot()) return;

		// Only in-place renames rename the folder; moves between folders do not.
		if (this.parentPathFromPath(oldPath) !== this.folderPath(folder)) return;

		// The renamed file must have been this folder's main note file.
		if (!this.isMainNoteFileName(folder, this.basenameWithoutExtension(oldPath))) return;

		// Nothing to do when the names already match (also breaks rename loops).
		if (file.basename === this.stripOrderPrefix(folder.name)) return;

		const index = this.parseOrderIndex(folder.name);
		const newName = this.sanitizeNoteName(file.basename);
		const targetFolderName = index !== null ? this.formatOrderName(index, newName) : newName;
		const parentPath = this.folderPath(folder.parent);
		const targetFolderPath = this.getAvailableFolderPath(parentPath, targetFolderName, folder.path);

		if (targetFolderPath !== folder.path) {
			await this.app.fileManager.renameFile(folder, targetFolderPath);
		}
		await this.ensureMainFileMatchesFolder(targetFolderPath, file.name);
	}

	/** Renames the note file after its folder was renamed. */
	private async syncNoteFileNameWithFolder(folder: TFolder, oldPath: string): Promise<void> {
		if (folder.isRoot()) return;

		const oldFolderName = this.basenameFromPath(oldPath);
		const oldStrippedName = this.stripOrderPrefix(oldFolderName);
		const mainFile = folder.children.find(
			(child): child is TFile => child instanceof TFile
				&& child.extension === 'md'
				&& (child.basename === oldStrippedName || child.basename === oldFolderName)
		);
		if (!mainFile) return;

		const expectedPath = this.joinPath(folder.path, this.mainNoteFileName(folder.path));
		if (mainFile.path === expectedPath) return;
		if (this.app.vault.getAbstractFileByPath(expectedPath)) return;

		await this.app.fileManager.renameFile(mainFile, expectedPath);
	}

	private async runBatched(task: () => Promise<void>): Promise<void> {
		this.suppressDepth++;
		try {
			await task();
		} finally {
			this.suppressDepth--;
		}
	}

	private async migrateLegacyChildren(): Promise<void> {
		const entries = this.normalizeLegacyChildren(this.plugin.consumeLegacyChildren());
		if (entries.length === 0) return;

		const legacyPaths = new Set<string>();
		for (const [parentPath, childPaths] of entries) {
			legacyPaths.add(parentPath);
			for (const childPath of childPaths) {
				legacyPaths.add(childPath);
			}
		}

		const migratedFiles = new Map<string, TFile>();
		for (const path of legacyPaths) {
			const file = this.app.vault.getFileByPath(path);
			if (file) {
				migratedFiles.set(path, await this.ensureCanonicalNoteFile(file));
			}
		}

		for (const [parentPath, childPaths] of entries) {
			const parentFile = migratedFiles.get(parentPath);
			if (!parentFile) continue;

			const parentFolder = await this.ensureCanonicalNoteFolder(parentFile);
			for (const childPath of childPaths) {
				const childFile = migratedFiles.get(childPath);
				if (!childFile || childFile.path === parentFile.path) continue;

				const movedFile = await this.moveNoteToParentFolder(childFile, parentFolder.path);
				migratedFiles.set(childPath, movedFile);
			}
		}

		await this.plugin.savePluginData();
	}

	/**
	 * Validates the untyped legacy children data (loaded from data.json) and
	 * returns it as a fully typed list of `[parentPath, childPaths]` pairs, so
	 * no `any` values flow into the typed vault APIs below.
	 */
	private normalizeLegacyChildren(raw: unknown): Array<[string, string[]]> {
		if (!raw || typeof raw !== 'object') return [];

		const entries: Array<[string, string[]]> = [];
		for (const [parentPath, childPaths] of Object.entries(raw as Record<string, unknown>)) {
			if (typeof parentPath !== 'string') continue;
			if (!Array.isArray(childPaths)) continue;

			const validChildren = childPaths.filter(
				(childPath): childPath is string => typeof childPath === 'string'
			);
			if (validChildren.length > 0) {
				entries.push([parentPath, validChildren]);
			}
		}
		return entries;
	}

	/**
	 * One-time migration from the layout where the order index was part of both
	 * the folder and its note file (`3 My note/3 My note.md`) to the layout where
	 * only the folder carries the index (`3 My note/My note.md`), so the index no
	 * longer shows up in tab titles or inline note headings.
	 */
	private async migrateNoteFileIndices(): Promise<void> {
		if (this.plugin.data.fileIndexMigrated) return;

		const folders = this.app.vault.getAllLoadedFiles().filter(
			(file): file is TFolder => file instanceof TFolder && !file.isRoot()
		);

		let renamedCount = 0;
		for (const folder of folders) {
			const mainFile = this.findMainNoteFile(folder);
			// Only touch folders that actually represent a note.
			if (!mainFile || !this.isMainNoteFileName(folder, mainFile.basename)) continue;

			const expectedName = this.mainNoteFileName(folder.path);
			if (mainFile.name === expectedName) continue;

			const targetPath = this.joinPath(folder.path, expectedName);
			if (this.app.vault.getAbstractFileByPath(targetPath)) continue;

			// renameFile keeps every existing link to this note intact.
			await this.app.fileManager.renameFile(mainFile, targetPath);
			renamedCount++;
		}

		this.plugin.data.fileIndexMigrated = true;
		await this.plugin.savePluginData();

		if (renamedCount > 0) {
			new Notice(
				`Nested notes: moved the order index onto the folder for ${renamedCount} ${renamedCount === 1 ? 'note' : 'notes'}.`
			);
		}
	}

	private async syncAllChildLinkBlocks(): Promise<void> {
		const topLevel = this.buildNoteTree();
		const allNodes = this.flattenNodes(topLevel);

		for (const node of allNodes) {
			await this.syncChildLinksForNode(node);
		}
	}

	private flattenNodes(nodes: NoteNode[]): NoteNode[] {
		const flattened: NoteNode[] = [];
		for (const node of nodes) {
			flattened.push(node, ...this.flattenNodes(node.children));
		}
		return flattened;
	}

	private async syncChildLinksForNode(node: NoteNode): Promise<void> {
		const block = node.children.length > 0
			? this.createChildLinksBlock(node)
			: '';
		const content = await this.app.vault.read(node.file);
		const nextContent = this.replaceChildLinksBlock(content, block);

		if (nextContent !== content) {
			await this.app.vault.modify(node.file, nextContent);
		}
	}

	private createChildLinksBlock(node: NoteNode): string {
		const links = node.children.map((child) => {
			const link = this.app.fileManager.generateMarkdownLink(
				child.file,
				node.file.path,
				undefined,
				this.displayBasename(child.file)
			);
			return `> - ${link}`;
		});

		return `${CHILD_LINKS_CALLOUT}\n${links.join('\n')}`;
	}

	private replaceChildLinksBlock(content: string, block: string): string {
		const calloutRegex = new RegExp(
			`(?:\\r?\\n)*> \\[!nested-notes\\][^\\r\\n]*(?:\\r?\\n>[^\\r\\n]*)*(?:\\r?\\n)*`,
			'g'
		);
		const legacyRegex = new RegExp(
			`(?:\\r?\\n)*${this.escapeRegExp(LEGACY_CHILD_LINKS_START)}[\\s\\S]*?${this.escapeRegExp(LEGACY_CHILD_LINKS_END)}(?:\\r?\\n)*`,
			'g'
		);
		const sourceContent: string = content;
		const contentWithoutBlock: string = sourceContent
			.replace(calloutRegex, '')
			.replace(legacyRegex, '')
			.trimEnd();

		if (!block) {
			return contentWithoutBlock ? `${contentWithoutBlock}\n` : '';
		}

		return contentWithoutBlock
			? `${contentWithoutBlock}\n\n${block}\n\n`
			: `${block}\n\n`;
	}

	private toggleCollapse(path: string): void {
		const idx = this.plugin.data.collapsed.indexOf(path);
		if (idx >= 0) {
			this.plugin.data.collapsed.splice(idx, 1);
		} else {
			this.plugin.data.collapsed.push(path);
		}
		void this.plugin.savePluginData();
		this.renderTree();
	}

	private getFileOrThrow(path: string): TFile {
		const file = this.app.vault.getFileByPath(path);
		if (!file) throw new Error(`Could not find note: ${path}`);
		return file;
	}

	private folderPath(folder: TFolder | null): string {
		if (!folder || folder.isRoot()) return '';
		return this.normalizeVaultPath(folder.path);
	}

	private joinPath(parentPath: string, childPath: string): string {
		return this.normalizeVaultPath(parentPath ? `${parentPath}/${childPath}` : childPath);
	}

	private normalizeVaultPath(path: string): string {
		const normalized = normalizePath(path);
		if (normalized === '/') return '';
		return normalized.replace(/^\/+/, '');
	}

	private basenameFromPath(path: string): string {
		const normalized = this.normalizeVaultPath(path);
		return normalized.split('/').pop() ?? normalized;
	}

	/** Folder that contains `path`, as a vault-relative path ('' for the root). */
	private parentPathFromPath(path: string): string {
		const normalized = this.normalizeVaultPath(path);
		const separatorIndex = normalized.lastIndexOf('/');
		return separatorIndex < 0 ? '' : normalized.slice(0, separatorIndex);
	}

	/** File name of `path` without its extension. */
	private basenameWithoutExtension(path: string): string {
		const name = this.basenameFromPath(path);
		const dotIndex = name.lastIndexOf('.');
		return dotIndex > 0 ? name.slice(0, dotIndex) : name;
	}

	private sanitizeNoteName(name: string): string {
		const sanitized = name
			.trim()
			.replace(/[\\/:*?"<>|#^[\]]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
		return sanitized || 'Untitled';
	}

	private escapeRegExp(text: string): string {
		return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}
}
