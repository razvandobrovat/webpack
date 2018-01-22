/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/
"use strict";

class ModuleReason {
	constructor(module, dependency, explanation) {
		this.module = module;
		this.dependency = dependency;
		this.explanation = explanation;
	}
}

Object.defineProperty(ModuleReason.prototype, "chunks", {
	configurable: false,
	get() {
		throw new Error("ModuleReason.chunks: This was removed without replacement");
	},
	set() {
		throw new Error("ModuleReason.chunks: This was removed without replacement");
	}
});

module.exports = ModuleReason;
