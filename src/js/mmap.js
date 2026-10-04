/*!
	wow.export (https://github.com/Kruithne/wow.export)
	Authors: Kruithne <kruithne@gmail.com>
	License: MIT
 */
const fs = require('fs');
const path = require('path');
const log = require('./log');
const constants = require('./constants');

/**
 * stand-in for the native MmapObject when mmap.node is not available (the
 * headless CLI under plain Node, where the shipped addon is built for NW.js):
 * the file is read into memory instead of mapped. same surface.
 */
class FileBackedObject {
	constructor() {
		this._data = null;
		this.lastError = '';
	}

	mapFile(file_path) {
		try {
			// the native object hands out a Uint8Array over the mapping
			const buf = fs.readFileSync(file_path);
			this._data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
			return true;
		} catch (e) {
			this.lastError = e.message;
			return false;
		}
	}

	mapAnonymous(size) {
		this._data = new Uint8Array(size);
		return true;
	}

	unmap() {
		this._data = null;
	}

	sync() {}

	get data() { return this._data; }
	get size() { return this._data ? this._data.byteLength : 0; }
	get isMapped() { return this._data !== null; }
}

let mmap_native;
try {
	mmap_native = require(path.join(constants.INSTALL_PATH, 'mmap.node'));
} catch (e) {
	if (!constants.HEADLESS)
		throw e;

	log.write('mmap.node unavailable (%s); reading files into memory instead', e.message);
	mmap_native = { MmapObject: FileBackedObject };
}

const virtual_files = new Set();

/**
 * create memory-mapped file object and track it for cleanup.
 * @returns {object} mmap object
 */
const create_virtual_file = () => {
	const mmap_obj = new mmap_native.MmapObject();
	virtual_files.add(mmap_obj);
	return mmap_obj;
};

/**
 * release all tracked memory-mapped files.
 * swallows errors to ensure all files are attempted.
 */
const release_virtual_files = () => {
	try {
		for (const mmap_obj of virtual_files) {
			try {
				if (mmap_obj.isMapped)
					mmap_obj.unmap();
			} catch (e) {
				// swallow individual unmap errors
			}
		}

		const count = virtual_files.size;
		virtual_files.clear();
		log.write('released %d memory-mapped files', count);
	} catch (e) {
		log.write('error during virtual file cleanup: %s', e.message);
	}
};

module.exports = {
	create_virtual_file,
	release_virtual_files
};
