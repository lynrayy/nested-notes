import {
	App,
	ItemView,
	Menu,
	Modal,
	Notice,
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

type SubmitNoteName = (name: string) => Promise<void>;

const CHILD_LINKS_CALLOUT = '> [!nested-notes]+ Pages inside';
const LEGACY_CHILD_LINKS_START = '<!-- nested-notes:children:start -->';
const LEGACY_CHILD_LINKS_END = '<!-- nested-notes:children:end -->';

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
						void this.createTopLevelNote();
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

			const dragged = e.dataTransfer?.getData('text/plain') ?? this.draggedPath;
			if (!dragged) return;
			void this.promoteToTopLevel(dragged);
		});

		this.registerEvent(
			this.app.vault.on('create', () => {
				void this.handleVaultStructureChange();
			})
		);
		this.registerEvent(
			this.app.vault.on('rename', () => {
				void this.handleVaultStructureChange();
			})
		);
		this.registerEvent(
			this.app.vault.on('delete', () => {
				void this.handleVaultStructureChange();
			})
		);

		await this.migrateLegacyChildren();
		await this.syncAllChildLinkBlocks();
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
			cls: 'cn-note-row',
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
			const nativeSvg = document
				.querySelector(`.nav-file-title[data-path="${CSS.escape(file.path)}"] svg`);
			if (nativeSvg) {
				iconSpan.appendChild(nativeSvg.cloneNode(true));
			} else {
				setIcon(iconSpan, 'file');
			}
		}

		const nameWrap = row.createSpan({cls: 'cn-name'});
		if (this.plugin.data.showFolderPath) {
			const folderPath = file.parent?.path;
			if (folderPath && folderPath !== '/' && folderPath !== '') {
				nameWrap.createSpan({cls: 'cn-folder-path', text: `${folderPath}/`});
			}
		}
		nameWrap.createSpan({text: file.basename});

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
			void this.createNestedNote(file);
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
			e.dataTransfer?.setData('text/plain', file.path);
			row.classList.add('cn-dragging');
		});
		row.addEventListener('dragend', () => {
			row.classList.remove('cn-dragging');
			this.draggedPath = null;
		});
		row.addEventListener('dragover', (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (!this.draggedPath) return;
			if (this.draggedPath === file.path) return;
			if (this.wouldMoveIntoSelf(this.draggedPath, file)) return;
			row.classList.add('cn-drag-over');
		});
		row.addEventListener('dragleave', (e) => {
			const related = e.relatedTarget as Node | null;
			if (!related || !row.contains(related)) {
				row.classList.remove('cn-drag-over');
			}
		});
		row.addEventListener('drop', (e) => {
			e.preventDefault();
			row.classList.remove('cn-drag-over');
			const dragged = e.dataTransfer?.getData('text/plain') ?? this.draggedPath;
			if (!dragged || dragged === file.path) return;
			if (this.wouldMoveIntoSelf(dragged, file)) return;
			void this.nestNote(dragged, file);
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

		for (const file of this.app.vault.getMarkdownFiles()) {
			const folder = this.getCanonicalNoteFolder(file);
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
			if (!this.hasCanonicalAncestor(node.file, canonicalNodes)) {
				topLevel.push(node);
			}
		}

		this.sortNodes(topLevel);
		return topLevel;
	}

	private sortNodes(nodes: NoteNode[]): void {
		nodes.sort((a, b) => a.file.basename.localeCompare(b.file.basename));
		for (const node of nodes) {
			this.sortNodes(node.children);
		}
	}

	private hasCanonicalAncestor(file: TFile, canonicalNodes: Map<string, NoteNode>): boolean {
		let folder = file.parent;
		while (folder && !folder.isRoot()) {
			if (canonicalNodes.has(folder.path)) return true;
			folder = folder.parent;
		}
		return false;
	}

	private async createTopLevelNote(): Promise<void> {
		const parentFolder = this.app.fileManager.getNewFileParent('');
		const file = await this.createNoteInFolder(this.folderPath(parentFolder), 'Untitled');
		await this.openNote(file);
		this.promptForNoteRename(file);
		await this.syncAllChildLinkBlocks();
		this.renderTree();
	}

	private async createNestedNote(parentFile: TFile): Promise<void> {
		const parentFolder = await this.ensureCanonicalNoteFolder(parentFile);
		const file = await this.createNoteInFolder(parentFolder.path, 'Untitled');
		await this.openNote(file);
		this.promptForNoteRename(file);
		await this.syncAllChildLinkBlocks();
		this.renderTree();
	}

	private async createNoteInFolder(parentFolderPath: string, preferredName: string): Promise<TFile> {
		const folderPath = this.getAvailableFolderPath(parentFolderPath, preferredName);
		await this.ensureFolder(folderPath);

		const folderName = this.basenameFromPath(folderPath);
		const filePath = this.joinPath(folderPath, `${folderName}.md`);
		return await this.app.vault.create(filePath, '');
	}

	private async openNote(file: TFile): Promise<void> {
		await this.app.workspace.getLeaf(false).openFile(file);
	}

	private promptForNoteRename(file: TFile): void {
		new NoteNameModal(this.app, file.basename, async (name) => {
			await this.renameNote(file, name);
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
			.setTitle('Rename...')
			.setIcon('pencil')
			.onClick(() => this.promptForNoteRename(file))
		);
		menu.addItem(item => item
			.setTitle('Delete')
			.setIcon('trash')
			.onClick(() => {
				void this.deleteNote(file);
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

	private async renameNote(file: TFile, name: string): Promise<void> {
		const canonicalFile = await this.ensureCanonicalNoteFile(file);
		const folder = this.getCanonicalNoteFolder(canonicalFile);
		if (!folder) throw new Error('Could not resolve note folder.');

		const newName = this.sanitizeNoteName(name);
		const parentPath = this.folderPath(folder.parent);
		const targetFolderPath = this.getAvailableFolderPath(parentPath, newName, folder.path);

		let fileAfterFolderMove = canonicalFile;
		if (targetFolderPath !== folder.path) {
			await this.app.fileManager.renameFile(folder, targetFolderPath);
			fileAfterFolderMove = this.getFileOrThrow(this.joinPath(targetFolderPath, canonicalFile.name));
		}

		const targetFilePath = this.joinPath(targetFolderPath, `${this.basenameFromPath(targetFolderPath)}.md`);
		if (fileAfterFolderMove.path !== targetFilePath) {
			await this.app.fileManager.renameFile(fileAfterFolderMove, targetFilePath);
		}

		await this.syncAllChildLinkBlocks();
		this.renderTree();
	}

	private async deleteNote(file: TFile): Promise<void> {
		const folder = this.getCanonicalNoteFolder(file);
		await this.app.fileManager.trashFile(folder ?? file);
		await this.syncAllChildLinkBlocks();
		this.renderTree();
	}

	private async promoteToTopLevel(path: string): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return;

		const topLevelParent = this.app.fileManager.getNewFileParent('');
		await this.moveNoteToParentFolder(file, this.folderPath(topLevelParent));
		await this.syncAllChildLinkBlocks();
		this.renderTree();
	}

	private async nestNote(childPath: string, parentFile: TFile): Promise<void> {
		const childFile = this.app.vault.getFileByPath(childPath);
		if (!childFile) return;

		const parentFolder = await this.ensureCanonicalNoteFolder(parentFile);
		await this.moveNoteToParentFolder(childFile, parentFolder.path);

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

		const folderName = this.basenameFromPath(folderPath);
		const targetPath = this.joinPath(folderPath, `${folderName}.md`);
		await this.app.fileManager.renameFile(file, targetPath);
		return this.getFileOrThrow(targetPath);
	}

	private async ensureMainFileMatchesFolder(folderPath: string, currentFileName: string): Promise<TFile> {
		const folderName = this.basenameFromPath(folderPath);
		const expectedPath = this.joinPath(folderPath, `${folderName}.md`);
		let file = this.app.vault.getFileByPath(this.joinPath(folderPath, currentFileName));

		if (!file) {
			const folder = this.app.vault.getFolderByPath(folderPath);
			const markdownFile = folder?.children.find((child): child is TFile => {
				return child instanceof TFile && child.extension === 'md';
			});
			file = markdownFile ?? null;
		}

		if (!file) throw new Error('Could not find note file after moving its folder.');
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

	private getCanonicalNoteFolder(file: TFile): TFolder | null {
		const folder = file.parent;
		if (!folder || folder.isRoot()) return null;
		return folder.name === file.basename ? folder : null;
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

	private async migrateLegacyChildren(): Promise<void> {
		const legacyChildren = this.plugin.consumeLegacyChildren();
		if (!legacyChildren) return;

		const legacyPaths = new Set<string>();
		for (const [parentPath, childPaths] of Object.entries(legacyChildren)) {
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

		for (const [parentPath, childPaths] of Object.entries(legacyChildren)) {
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
				child.file.basename
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
		const contentWithoutBlock = content
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
