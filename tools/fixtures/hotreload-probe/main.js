/*
 * Test fixture loaded by tools/hotreload-check.mjs into a *copy* of a vault.
 *
 * Each onload bumps a counter on window so the harness can prove the plugin
 * was really unloaded and re-evaluated after main.js changed on disk.
 */
const { Plugin } = require("obsidian");

module.exports = class MyObsHotReloadProbe extends Plugin {
	async onload() {
		window.__myobsProbeLoads = (window.__myobsProbeLoads || 0) + 1;
		console.log("[myobs-hotreload-probe] onload #" + window.__myobsProbeLoads);
	}

	onunload() {
		window.__myobsProbeUnloads = (window.__myobsProbeUnloads || 0) + 1;
		console.log("[myobs-hotreload-probe] onunload #" + window.__myobsProbeUnloads);
	}
};
