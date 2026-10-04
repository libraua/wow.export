#!/usr/bin/env node
/*!
	wow.export (https://github.com/Kruithne/wow.export)
	Authors: Kruithne <kruithne@gmail.com>
	License: MIT
 */

// Headless command line: search a local install's listfile and export models
// (M2 / WMO, as glTF with textures and animations) and textures (BLP -> PNG)
// without the GUI. Runs under plain Node (>= 24) from a source checkout:
//
//   node src/cli.js search bow_2h
//   node src/cli.js export item/objectcomponents/weapon/bow_2h_kultiran_d_01.m2
//
// It reuses the GUI's user data (its config, listfile and build caches) unless
// --data points elsewhere, and never writes the GUI's config.

const fs = require('fs');
const os = require('os');
const path = require('path');

const USAGE = `wow.export command line

usage:
  node src/cli.js search <text | /regex/> [--ext .m2] [--limit 100]
  node src/cli.js export <file path | fileDataID>... [--out <dir>] [--format gltf|glb|obj] [--skin <n>] [--no-anims] [--no-textures]

options:
  --wow <dir>       the World of Warcraft install (default: the GUI's most recent local install)
  --product <name>  the product to load (default: the GUI's most recent, else "wow")
  --data <dir>      wow.export's user data (default: the GUI's, %LOCALAPPDATA%/wow.export/User Data/Default)
  --out <dir>       export directory (default: the GUI's exportDirectory)
  --format <fmt>    model format: gltf (default), glb or obj
  --skin <n>        item/creature texture variant to apply (default 0, the first)
  --no-anims        models without their animations
  --no-textures     models without their textures
  --verbose         echo wow.export's own log`;

// ─── arguments ──────────────────────────────────────────────────────────────

const parse_args = (argv) => {
	const positional = [];
	const options = {};
	const flags = new Set(['no-anims', 'no-textures', 'verbose', 'help']);
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith('--')) {
			const name = arg.slice(2);
			if (flags.has(name))
				options[name] = true;
			else
				options[name] = argv[++i];
		} else {
			positional.push(arg);
		}
	}
	return { command: positional.shift(), targets: positional, options };
};

const { command, targets, options } = parse_args(process.argv.slice(2));
if (!command || options.help || !['search', 'export'].includes(command)) {
	console.log(USAGE);
	process.exit(command && !options.help ? 1 : 0);
}

// ─── the NW.js runtime, as far as the modules reach for it ──────────────────

const DEFAULT_DATA = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'wow.export', 'User Data', 'Default');
const DATA_PATH = path.resolve(options.data ?? process.env.WOWEXPORT_DATA ?? DEFAULT_DATA);
const PACKAGE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

fs.mkdirSync(DATA_PATH, { recursive: true });
globalThis.BUILD_RELEASE = true;
globalThis.nw = {
	App: {
		headless: true,
		dataPath: DATA_PATH,
		argv: process.argv.slice(2),
		manifest: { version: PACKAGE.version, flavour: 'cli', guid: 'cli' }
	},
	Shell: { openItem() {}, openExternal() {}, showItemInFolder() {} },
	__dirname: __dirname
};

const constants = require('./js/constants');
const log = require('./js/log');
const core = require('./js/core');
const generics = require('./js/generics');
const listfile = require('./js/casc/listfile');
const tactKeys = require('./js/casc/tact-keys');
const dbd_manifest = require('./js/casc/dbd-manifest');
const CASCLocal = require('./js/casc/casc-source-local');
const ExportHelper = require('./js/casc/export-helper');
const BLPFile = require('./js/casc/blp');
const M2Exporter = require('./js/3D/exporters/M2Exporter');
const WMOExporter = require('./js/3D/exporters/WMOExporter');
const DBModelFileData = require('./js/db/caches/DBModelFileData');
const DBItemDisplays = require('./js/db/caches/DBItemDisplays');

if (options.verbose) {
	const write = log.write;
	log.write = (...args) => {
		write(...args);
		console.log('[log]', require('util').format(...args));
	};
}

// ─── the view the GUI's Vue app would have been ─────────────────────────────

const read_config = () => {
	// the defaults (comment lines out), the user's on top - read only
	const defaults_text = fs.readFileSync(constants.CONFIG.DEFAULT_PATH, 'utf8')
		.split(/\r?\n/).filter(line => !line.trim().startsWith('//')).join('\n');
	const config = JSON.parse(defaults_text);
	if (fs.existsSync(constants.CONFIG.USER_PATH))
		Object.assign(config, JSON.parse(fs.readFileSync(constants.CONFIG.USER_PATH, 'utf8')));
	return config;
};

const make_view = () => {
	const view = core.makeNewView();
	view.config = read_config();
	// the watches the modules set up (the locale, the config's save) - the
	// command line changes nothing after start, so an immediate call is all
	view.$watch = (key, callback, opts) => {
		if (opts?.immediate) {
			const value = key.split('.').reduce((o, k) => o?.[k], view);
			callback(value);
		}
		return () => {};
	};
	return view;
};

core.view = make_view();
const config = core.view.config;
if (options.out)
	config.exportDirectory = path.resolve(options.out);
if (options.format)
	config.exportModelFormat = options.format.toUpperCase();
if (options['no-anims'])
	config.modelsExportAnimations = false;
if (options['no-textures'])
	config.modelsExportTextures = false;
if (!config.exportDirectory)
	config.exportDirectory = path.join(os.homedir(), 'wow.export');
core.view.selectedCDNRegion = { tag: config.sourceSelectUserRegion || 'us' };

// no loading screen, no toasts: progress and messages go to the console
core.showLoadingScreen = () => {};
core.hideLoadingScreen = () => {};
core.progressLoadingScreen = async (text) => {
	if (text)
		console.log('  ' + text);
};
core.setToast = (type, message) => {
	if (type === 'error')
		console.error(message);
	else if (options.verbose)
		console.log(`[${type}] ${message}`);
};

// ─── the install ────────────────────────────────────────────────────────────

const open_install = async () => {
	const recent = config.recentLocal?.[0];
	const dir = options.wow ?? recent?.path;
	if (!dir)
		throw new Error('no install: pass --wow <dir> (the GUI has none recent either)');

	const product = options.product ?? recent?.product ?? 'wow';
	console.log(`opening ${dir} (${product})`);

	try {
		await tactKeys.load();
	} catch (e) {
		log.write('tact keys unavailable: %s', e.message);
	}
	listfile.preload();
	dbd_manifest.preload();

	const casc = new CASCLocal(dir);
	await casc.init();
	const index = casc.builds.findIndex(build => build.Product === product);
	if (index < 0)
		throw new Error(`no "${product}" build in ${dir}: ${casc.builds.map(b => b.Product).join(', ')}`);

	await casc.load(index);
	console.log(`loaded build ${casc.build.Version ?? casc.build.BuildKey}`);
	return casc;
};

// ─── commands ───────────────────────────────────────────────────────────────

const parse_search = (text) => {
	const regex = text.match(/^\/(.+)\/([a-z]*)$/);
	return regex ? new RegExp(regex[1], regex[2] || 'i') : text.toLowerCase();
};

const run_search = async () => {
	if (targets.length === 0)
		throw new Error('search: what to look for?');

	await open_install();
	const limit = parseInt(options.limit ?? '100');
	const ext = options.ext?.toLowerCase();
	let results = listfile.getFilteredEntries(parse_search(targets[0]));
	if (ext)
		results = results.filter(entry => entry.fileName.endsWith(ext));

	results.sort((a, b) => a.fileName.localeCompare(b.fileName));
	for (const entry of results.slice(0, limit))
		console.log(`${entry.fileDataID}\t${entry.fileName}`);

	console.log(`${results.length} match${results.length === 1 ? '' : 'es'}${results.length > limit ? ` (first ${limit} shown; --limit for more)` : ''}`);
};

let item_displays_ready = false;
const variant_textures = async (file_data_id) => {
	// the GUI's first skin: an item display's textures (a bow's wood and
	// string come from its ItemDisplayInfo, not the model)
	if (!item_displays_ready) {
		try {
			await DBModelFileData.initializeModelFileData();
			await DBItemDisplays.initializeItemDisplays();
		} catch (e) {
			log.write('item displays unavailable: %s', e.message);
		}
		item_displays_ready = true;
	}

	const displays = DBItemDisplays.getItemDisplaysByFileDataID(file_data_id)?.filter(d => d.textures.length > 0) ?? [];
	const skin = parseInt(options.skin ?? '0');
	return displays[Math.min(skin, displays.length - 1)]?.textures ?? [];
};

const resolve_target = (target) => {
	const by_id = /^\d+$/.test(target) ? parseInt(target) : undefined;
	const file_data_id = by_id ?? listfile.getByFilename(target);
	if (file_data_id === undefined)
		throw new Error(`not in the listfile: ${target}`);

	const file_name = listfile.getByID(file_data_id) ?? listfile.formatUnknownFile(file_data_id, '.m2');
	return { file_data_id, file_name };
};

const run_export = async () => {
	if (targets.length === 0)
		throw new Error('export: which files?');

	const casc = await open_install();
	const format = config.exportModelFormat.toLowerCase();
	const helper = new ExportHelper(targets.length, 'file');
	helper.start();
	let failures = 0;

	for (const target of targets) {
		try {
			const { file_data_id, file_name } = resolve_target(target);
			const ext = path.extname(file_name).toLowerCase();
			const data = await casc.getFile(file_data_id);
			const export_path = ExportHelper.getExportPath(file_name);
			let written;

			if (ext === '.m2') {
				const exporter = new M2Exporter(data, await variant_textures(file_data_id), file_data_id);
				if (format === 'obj') {
					written = ExportHelper.replaceExtension(export_path, '.obj');
					await exporter.exportAsOBJ(written, config.modelsExportCollision, helper);
				} else {
					written = ExportHelper.replaceExtension(export_path, format === 'glb' ? '.glb' : '.gltf');
					await exporter.exportAsGLTF(written, helper, format === 'glb' ? 'glb' : 'gltf');
				}
			} else if (ext === '.wmo') {
				const exporter = new WMOExporter(data, file_data_id);
				if (format === 'obj') {
					written = ExportHelper.replaceExtension(export_path, '.obj');
					await exporter.exportAsOBJ(written, helper);
				} else {
					written = ExportHelper.replaceExtension(export_path, format === 'glb' ? '.glb' : '.gltf');
					await exporter.exportAsGLTF(written, helper, format === 'glb' ? 'glb' : 'gltf');
				}
				WMOExporter.clearCache();
			} else if (ext === '.blp') {
				written = ExportHelper.replaceExtension(export_path, '.png');
				await new BLPFile(data).saveToPNG(written);
			} else {
				written = export_path;
				await data.writeToFile(written);
			}

			helper.mark(file_name, true);
			console.log(`exported ${file_name} -> ${written}`);
		} catch (e) {
			failures++;
			helper.mark(target, false, e.message, e.stack);
			console.error(`failed ${target}: ${e.message}`);
			log.write('%o', e);
		}
	}

	helper.finish();
	if (failures > 0)
		process.exitCode = 1;
};

(async () => {
	try {
		await (command === 'search' ? run_search() : run_export());
	} catch (e) {
		console.error(e.message);
		log.write('%o', e);
		process.exitCode = 1;
	} finally {
		// the build cache, the mapped files and timers would keep Node alive
		setTimeout(() => process.exit(), 200);
	}
})();
