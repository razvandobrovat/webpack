/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/
"use strict";

const util = require("util");

const DependenciesBlock = require("./DependenciesBlock");
const ModuleReason = require("./ModuleReason");
const SortableSet = require("./util/SortableSet");
const Template = require("./Template");
const ChunkGroup = require("./ChunkGroup");

const EMPTY_RESOLVE_OPTIONS = {};

let debugId = 1000;

const sortById = (a, b) => {
	return a.id - b.id;
};

const sortByDebugId = (a, b) => {
	return a.debugId - b.debugId;
};

const getFrozenArray = set => Object.freeze(Array.from(set));

class Module extends DependenciesBlock {

	constructor(type) {
		super();
		this.type = type;

		// Unique Id
		this.debugId = debugId++;

		// Hash
		this.hash = undefined;
		this.renderedHash = undefined;

		// Info from Factory
		// TODO refactor: pass as constructor argument
		this.context = null;
		this.resolveOptions = EMPTY_RESOLVE_OPTIONS;
		this.factoryMeta = {};

		// Info from Build
		this.warnings = [];
		this.errors = [];
		this.buildMeta = undefined;
		this.buildInfo = undefined;

		// Graph (per Compilation)
		this.reasons = [];
		this._chunks = new SortableSet(undefined, sortById);

		// Info from Compilation (per Compilation)
		this.id = null;
		this.index = null;
		this.index2 = null;
		this.depth = null;
		this.issuer = null;
		this.profile = undefined;
		this.prefetched = false;
		this.built = false;

		// Info from Optimization (per Compilation)
		this.used = null;
		this.usedExports = null;
		this.optimizationBailout = [];
	}

	get exportsArgument() {
		return this.buildInfo && this.buildInfo.exportsArgument || "exports";
	}

	get moduleArgument() {
		return this.buildInfo && this.buildInfo.moduleArgument || "module";
	}

	disconnect() {
		this.hash = undefined;
		this.renderedHash = undefined;

		this.reasons.length = 0;
		this._chunks.clear();

		this.id = null;
		this.index = null;
		this.index2 = null;
		this.depth = null;
		this.issuer = null;
		this.profile = undefined;
		this.prefetched = false;
		this.built = false;

		this.used = null;
		this.usedExports = null;
		this.optimizationBailout.length = 0;
		super.disconnect();
	}

	unseal() {
		this.id = null;
		this.index = null;
		this.index2 = null;
		this.depth = null;
		this._chunks.clear();
		super.unseal();
	}

	setChunks(chunks) {
		this._chunks = new SortableSet(chunks, sortById);
	}

	addChunk(chunk) {
		if(this._chunks.has(chunk))
			return false;
		this._chunks.add(chunk);
		return true;
	}

	removeChunk(chunk) {
		if(this._chunks.delete(chunk)) {
			chunk.removeModule(this);
			return true;
		}
		return false;
	}

	isInChunk(chunk) {
		return this._chunks.has(chunk);
	}

	isEntryModule() {
		for(const chunk of this._chunks) {
			if(chunk.entryModule === this)
				return true;
		}
		return false;
	}

	get optional() {
		return this.reasons.length > 0 && this.reasons.every(r => r.dependency && r.dependency.optional);
	}

	forEachChunk(fn) {
		this._chunks.forEach(fn);
	}

	mapChunks(fn) {
		return Array.from(this._chunks, fn);
	}

	getChunks() {
		return Array.from(this._chunks);
	}

	getNumberOfChunks() {
		return this._chunks.size;
	}

	get chunksIterable() {
		return this._chunks;
	}

	hasEqualsChunks(otherModule) {
		if(this._chunks.size !== otherModule._chunks.size) return false;
		this._chunks.sortWith(sortByDebugId);
		otherModule._chunks.sortWith(sortByDebugId);
		const a = this._chunks[Symbol.iterator]();
		const b = otherModule._chunks[Symbol.iterator]();
		while(true) { // eslint-disable-line
			const aItem = a.next();
			const bItem = b.next();
			if(aItem.done) return true;
			if(aItem.value !== bItem.value) return false;
		}
	}

	addReason(module, dependency, explanation) {
		this.reasons.push(new ModuleReason(module, dependency, explanation));
	}

	removeReason(module, dependency) {
		for(let i = 0; i < this.reasons.length; i++) {
			let r = this.reasons[i];
			if(r.module === module && r.dependency === dependency) {
				this.reasons.splice(i, 1);
				return true;
			}
		}
		return false;
	}

	isAccessibleInChunk(chunk, ignoreChunk) {
		// Check if module is accessible in ALL chunk groups
		for(const chunkGroup of chunk.groupsIterable) {
			if(!this.isAccessibleInChunkGroup(chunkGroup))
				return false;
		}
		return true;
	}

	isAccessibleInChunkGroup(chunkGroup, ignoreChunk) {
		const queue = new Set([chunkGroup]);

		// Check if module is accessible from all items of the queue
		queueFor: for(const cg of queue) {
			// 1. If module is in one of the chunks of the group we can continue checking the next items
			//    because it's accessible.
			for(const chunk of cg.chunks) {
				if(chunk !== ignoreChunk && chunk.containsModule(this))
					continue queueFor;
			}
			// 2. If the chunk group is initial, we can break here because it's not accessible.
			if(chunkGroup.isInitial())
				return false;
			// 3. Enqueue all parents because it must be accessible from ALL parents
			for(const parent of chunkGroup.parentsIterable)
				queue.add(parent);
		}
		// When we processed through the whole list and we didn't bailout, the module is accessible
		return true;
	}

	hasReasonForChunk(chunk) {
		// check for each reason if we need the chunk
		for(const reason of this.reasons) {
			const fromModule = reason.module;
			for(const originChunk of fromModule.chunksIterable) {
				// return true if module this is not reachable from originChunk when ignoring cunk
				if(!this.isAccessibleInChunk(originChunk, chunk))
					return true;
			}
		}
		return false;
	}

	hasReasons() {
		return this.reasons.length > 0;
	}

	isUsed(exportName) {
		if(!exportName) return this.used !== false;
		if(this.used === null || this.usedExports === null) return exportName;
		if(!this.used) return false;
		if(!this.usedExports) return false;
		if(this.usedExports === true) return exportName;
		let idx = this.usedExports.indexOf(exportName);
		if(idx < 0) return false;

		// Mangle export name if possible
		if(this.isProvided(exportName)) {
			if(this.buildMeta.exportsType === "namespace")
				return Template.numberToIdentifer(idx);
			else if(this.buildMeta.exportsType === "named" && !this.usedExports.includes("default"))
				return Template.numberToIdentifer(idx);
		}
		return exportName;
	}

	isProvided(exportName) {
		if(!Array.isArray(this.buildMeta.providedExports))
			return null;
		return this.buildMeta.providedExports.includes(exportName);
	}

	toString() {
		return `Module[${this.id || this.debugId}]`;
	}

	needRebuild(fileTimestamps, contextTimestamps) {
		return true;
	}

	updateHash(hash) {
		hash.update(`${this.id}`);
		hash.update(JSON.stringify(this.usedExports));
		super.updateHash(hash);
	}

	sortItems(sortChunks) {
		super.sortItems();
		if(sortChunks)
			this._chunks.sort();
		this.reasons.sort((a, b) => {
			if(a.module === b.module) return 0;
			if(!a.module) return -1;
			if(!b.module) return 1;
			return sortById(a.module, b.module);
		});
		if(Array.isArray(this.usedExports)) {
			this.usedExports.sort();
		}
	}

	unbuild() {
		this.dependencies.length = 0;
		this.blocks.length = 0;
		this.variables.length = 0;
		this.buildMeta = undefined;
		this.buildInfo = undefined;
		this.disconnect();
	}

	get arguments() {
		throw new Error("Module.arguments was removed, there is no replacement.");
	}

	set arguments(value) {
		throw new Error("Module.arguments was removed, there is no replacement.");
	}
}

Object.defineProperty(Module.prototype, "entry", {
	configurable: false,
	get() {
		throw new Error("Module.entry was removed. Use Chunk.entryModule");
	},
	set() {
		throw new Error("Module.entry was removed. Use Chunk.entryModule");
	}
});

Object.defineProperty(Module.prototype, "chunks", {
	configurable: false,
	get: util.deprecate(function() {
		return this._chunks.getFromCache(getFrozenArray);
	}, "Module.chunks: Use Module.forEachChunk/mapChunks/getNumberOfChunks/isInChunk/addChunk/removeChunk instead"),
	set() {
		throw new Error("Readonly. Use Module.addChunk/removeChunk to modify chunks.");
	}
});

Object.defineProperty(Module.prototype, "meta", {
	configurable: false,
	get: util.deprecate(function() {
		return this.buildMeta;
	}, "Module.meta was renamed to Module.buildMeta"),
	set: util.deprecate(function(value) {
		this.buildMeta = value;
	}, "Module.meta was renamed to Module.buildMeta"),
});

Module.prototype.identifier = null;
Module.prototype.readableIdentifier = null;
Module.prototype.build = null;
Module.prototype.source = null;
Module.prototype.size = null;
Module.prototype.nameForCondition = null;

module.exports = Module;
