/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/
"use strict";

const util = require("util");
const SortableSet = require("./util/SortableSet");
const GraphHelpers = require("./GraphHelpers");
let debugId = 1000;

const sortById = (a, b) => {
	if(a.id < b.id) return -1;
	if(b.id < a.id) return 1;
	return 0;
};

const sortByIdentifier = (a, b) => {
	if(a.identifier() > b.identifier()) return 1;
	if(a.identifier() < b.identifier()) return -1;
	return 0;
};

const getFrozenArray = set => Object.freeze(Array.from(set));

const getModulesIdent = set => {
	set.sort();
	let str = "";
	set.forEach(m => {
		str += m.identifier() + "#";
	});
	return str;
};

const getArray = set => Array.from(set);

const getModulesSize = set => {
	let count = 0;
	for(const module of set) {
		count += module.size();
	}
	return count;
};

class Chunk {

	constructor(name) {
		this.id = null;
		this.ids = null;
		this.debugId = debugId++;
		this.name = name;
		this.entryModule = undefined;
		this._modules = new SortableSet(undefined, sortByIdentifier);
		this._groups = new SortableSet(undefined, sortById);
		this.files = [];
		this.rendered = false;
		this.hash = undefined;
		this.renderedHash = undefined;
		this.chunkReason = undefined;
		this.extraAsync = false;
	}

	get entry() {
		throw new Error("Chunk.entry was removed. Use hasRuntime()");
	}

	set entry(data) {
		throw new Error("Chunk.entry was removed. Use hasRuntime()");
	}

	get initial() {
		throw new Error("Chunk.initial was removed. Use isInitial()");
	}

	set initial(data) {
		throw new Error("Chunk.initial was removed. Use isInitial()");
	}

	hasRuntime() {
		for(const chunkGroup of this._groups) {
			// We only need to check the first one
			return chunkGroup.isInitial() && chunkGroup.getRuntimeChunk() === this;
		}
		return false;
	}

	isInitial() {
		for(const chunkGroup of this._groups) {
			// We only need to check the first one
			return chunkGroup.isInitial();
		}
		return false;
	}

	hasEntryModule() {
		return !!this.entryModule;
	}

	addModule(module) {
		if(!this._modules.has(module)) {
			this._modules.add(module);
			return true;
		}
		return false;
	}

	removeModule(module) {
		if(this._modules.delete(module)) {
			module.removeChunk(this);
			return true;
		}
		return false;
	}

	setModules(modules) {
		this._modules = new SortableSet(modules, sortByIdentifier);
	}

	getNumberOfModules() {
		return this._modules.size;
	}

	get modulesIterable() {
		return this._modules;
	}

	// TODO remove and replace calls with for of loop
	forEachModule(fn) {
		this._modules.forEach(fn);
	}

	// TODO remove and replace calls with Array.from
	mapModules(fn) {
		return Array.from(this._modules, fn);
	}

	addGroup(chunkGroup) {
		if(this._groups.has(chunkGroup))
			return false;
		this._groups.add(chunkGroup);
		return true;
	}

	removeGroup(chunkGroup) {
		if(!this._groups.has(chunkGroup))
			return false;
		this._groups.delete(chunkGroup);
		return true;
	}

	isInGroup(chunkGroup) {
		return this._groups.has(chunkGroup);
	}

	getNumberOfGroups() {
		return this._groups.siz;
	}

	get groupsIterable() {
		return this._groups;
	}

	compareTo(otherChunk) {
		this._modules.sort();
		otherChunk._modules.sort();
		if(this._modules.size > otherChunk._modules.size) return -1;
		if(this._modules.size < otherChunk._modules.size) return 1;
		const a = this._modules[Symbol.iterator]();
		const b = otherChunk._modules[Symbol.iterator]();
		while(true) { // eslint-disable-line
			const aItem = a.next();
			const bItem = b.next();
			if(aItem.done) return 0;
			const aModuleIdentifier = aItem.value.identifier();
			const bModuleIdentifier = bItem.value.identifier();
			if(aModuleIdentifier > bModuleIdentifier) return -1;
			if(aModuleIdentifier < bModuleIdentifier) return 1;
		}
	}

	containsModule(module) {
		return this._modules.has(module);
	}

	getModules() {
		return this._modules.getFromCache(getArray);
	}

	getModulesIdent() {
		return this._modules.getFromUnorderedCache(getModulesIdent);
	}

	remove(reason) {
		// cleanup modules
		// Array.from is used here to create a clone, because removeChunk modifies this._modules
		for(const module of Array.from(this._modules)) {
			module.removeChunk(this);
		}
		for(const chunkGroup of this._groups) {
			chunkGroup.removeChunk(this);
		}
	}

	moveModule(module, otherChunk) {
		GraphHelpers.disconnectChunkAndModule(this, module);
		GraphHelpers.connectChunkAndModule(otherChunk, module);
	}

	integrate(otherChunk, reason) {
		if(!this.canBeIntegrated(otherChunk)) {
			return false;
		}

		// Array.from is used here to create a clone, because moveModule modifies otherChunk._modules
		for(const module of Array.from(otherChunk._modules)) {
			otherChunk.moveModule(module, this);
		}
		otherChunk._modules.clear();

		for(const chunkGroup of otherChunk._groups) {
			chunkGroup.replaceChunk(otherChunk, this);
			this.addGroup(chunkGroup);
		}
		otherChunk._groups.clear();

		if(this.name && otherChunk.name) {
			if(this.name.length !== otherChunk.name.length)
				this.name = this.name.length < otherChunk.name.length ? this.name : otherChunk.name;
			else
				this.name = this.name < otherChunk.name ? this.name : otherChunk.name;
		}

		return true;
	}

	split(newChunk) {
		for(const chunkGroup of this._groups) {
			chunkGroup.insertChunk(newChunk, this);
			newChunk.addGroup(chunkGroup);
		}
	}

	isEmpty() {
		return this._modules.size === 0;
	}

	updateHash(hash) {
		hash.update(`${this.id} `);
		hash.update(this.ids ? this.ids.join(",") : "");
		hash.update(`${this.name || ""} `);
		this._modules.forEach(m => hash.update(m.hash));
	}

	canBeIntegrated(otherChunk) {
		const isAvailable = (a, b) => {
			const queue = new Set(b.groupsIterable);
			for(const chunkGroup of queue) {
				if(a.isInGroup(chunkGroup)) continue;
				if(chunkGroup.isInitial()) return false;
				for(const parent of chunkGroup.parentsIterable)
					queue.add(parent);
			}
			return true;
		};
		if(this.isInitial() !== otherChunk.isInitial()) {
			if(this.isInitial()) {
				return isAvailable(this, otherChunk);
			} else if(otherChunk.isInitial()) {
				return isAvailable(otherChunk, this);
			} else {
				return false;
			}
		}
		if(this.hasEntryModule() || otherChunk.hasEntryModule())
			return false;
		return true;
	}

	addMultiplierAndOverhead(size, options) {
		const overhead = typeof options.chunkOverhead === "number" ? options.chunkOverhead : 10000;
		const multiplicator = this.isInitial() ? (options.entryChunkMultiplicator || 10) : 1;

		return size * multiplicator + overhead;
	}

	modulesSize() {
		return this._modules.getFromUnorderedCache(getModulesSize);
	}

	size(options) {
		return this.addMultiplierAndOverhead(this.modulesSize(), options);
	}

	integratedSize(otherChunk, options) {
		// Chunk if it's possible to integrate this chunk
		if(!this.canBeIntegrated(otherChunk)) {
			return false;
		}

		let integratedModulesSize = this.modulesSize();
		// only count modules that do not exist in this chunk!
		for(const otherModule of otherChunk._modules) {
			if(!this._modules.has(otherModule)) {
				integratedModulesSize += otherModule.size();
			}
		}

		return this.addMultiplierAndOverhead(integratedModulesSize, options);
	}

	sortModules(sortByFn) {
		this._modules.sortWith(sortByFn || sortById);
	}

	sortItems(sortChunks) {
		this.sortModules();
	}

	getChunkMaps(includeInitial, realHash) {
		const chunkHashMap = Object.create(null);
		const chunkNameMap = Object.create(null);

		const queue = new Set(this.groupsIterable);
		const chunks = new Set();

		for(const chunkGroup of queue) {
			if(includeInitial || !chunkGroup.isInitial())
				for(const chunk of chunkGroup.chunks)
					chunks.add(chunk);
			for(const child of chunkGroup.childrenIterable)
				queue.add(child);
		}

		for(const chunk of chunks) {
			chunkHashMap[chunk.id] = realHash ? chunk.hash : chunk.renderedHash;
			if(chunk.name)
				chunkNameMap[chunk.id] = chunk.name;
		}

		return {
			hash: chunkHashMap,
			name: chunkNameMap
		};
	}

	getChunkModuleMaps(includeInitial, filterFn) {
		const chunkModuleIdMap = Object.create(null);
		const chunkModuleHashMap = Object.create(null);

		const queue = new Set(this.groupsIterable);
		const chunks = new Set();

		for(const chunkGroup of queue) {
			if(includeInitial || !chunkGroup.isInitial())
				for(const chunk of chunkGroup.chunks)
					chunks.add(chunk);
			for(const child of chunkGroup.childrenIterable)
				queue.add(child);
		}

		for(const chunk of chunks) {
			let array;
			for(const module of chunk.modulesIterable) {
				if(filterFn(module)) {
					if(array === undefined) {
						array = [];
						chunkModuleIdMap[chunk.id] = array;
					}
					array.push(module.id);
					chunkModuleHashMap[module.id] = module.renderedHash;
				}
			}
			if(array !== undefined) {
				array.sort();
			}
		}

		return {
			id: chunkModuleIdMap,
			hash: chunkModuleHashMap
		};
	}

	hasModuleInGraph(filterFn, filterChunkFn) {
		const queue = new Set(this.groupsIterable);
		const chunksProcessed = new Set();

		for(const chunkGroup of queue) {
			for(const chunk of chunkGroup.chunks) {
				if(!chunksProcessed.has(chunk)) {
					chunksProcessed.add(chunk);
					if(!filterChunkFn || filterChunkFn(chunk)) {
						for(const module of chunk.modulesIterable)
							if(filterFn(module))
								return true;
					}
				}
			}
			for(const child of chunkGroup.childrenIterable)
				queue.add(child);
		}
		return false;
	}

	toString() {
		return `Chunk[${Array.from(this._modules).join()}]`;
	}
}

Object.defineProperty(Chunk.prototype, "modules", {
	configurable: false,
	get: util.deprecate(function() {
		return this._modules.getFromCache(getFrozenArray);
	}, "Chunk.modules is deprecated. Use Chunk.getNumberOfModules/mapModules/forEachModule/containsModule instead."),
	set: util.deprecate(function(value) {
		this.setModules(value);
	}, "Chunk.modules is deprecated. Use Chunk.addModule/removeModule instead.")
});

Object.defineProperty(Chunk.prototype, "chunks", {
	configurable: false,
	get() {
		throw new Error("Chunk.chunks: Use ChunkGroup.getChildren() instead");
	},
	set() {
		throw new Error("Chunk.chunks: Use ChunkGroup.add/removeChild() instead");
	}
});

Object.defineProperty(Chunk.prototype, "parents", {
	configurable: false,
	get() {
		throw new Error("Chunk.parents: Use ChunkGroup.getParents() instead");
	},
	set() {
		throw new Error("Chunk.parents: Use ChunkGroup.add/removeParent() instead");
	}
});

Object.defineProperty(Chunk.prototype, "blocks", {
	configurable: false,
	get() {
		throw new Error("Chunk.blocks: Use ChunkGroup.getBlocks() instead");
	},
	set() {
		throw new Error("Chunk.blocks: Use ChunkGroup.add/removeBlock() instead");
	}
});

Object.defineProperty(Chunk.prototype, "entrypoints", {
	configurable: false,
	get() {
		throw new Error("Chunk.entrypoints: Use Chunks.groupsIterable and filter by instanceof Entrypoint instead");
	},
	set() {
		throw new Error("Chunk.entrypoints: Use Chunks.addGroup instead");
	}
});

module.exports = Chunk;
