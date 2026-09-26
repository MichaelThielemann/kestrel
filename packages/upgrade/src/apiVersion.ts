/**
 * The version of the plugin API. It covers every type `./plugin` exports, the ones a plugin
 * returns to the engine as much as the ones it receives: `UpgradePlugin`, `LoadResult`,
 * `LoadedProject`, `LoadIssue`, `PipelineFile`, `DataContentModel` and its parts,
 * `SwitchEditsResult`, `Rule` with its `needs` values, `RuleContext`/`SourceRuleContext`, the
 * locator types, `Finding`/`Edit`, `KestrelPluginHost`, `HostProblem`, `KestrelPluginFactory` and
 * `RunUpgradeCliOptions`. A member added to any of them is optional, and a new `needs` value is a
 * new variant of `Rule`; each such addition raises this number by one. An engine older than an
 * addition ignores a hook or member it does not know, so a plugin that relies on one compares the
 * number it receives in `KestrelPluginHost.pluginApiVersion` first. The number only grows: a new
 * major of this package continues from the previous major's value and never resets it.
 */
export const PLUGIN_API_VERSION = 4;

/** The lowest `pluginApi` a host package may declare for this engine to run its plugin; a major that removes an API member raises it. */
export const PLUGIN_API_MIN = 4;
