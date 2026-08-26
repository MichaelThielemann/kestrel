import { defineAsyncComponent, type Component } from 'vue'
import type { FieldType } from '@michaelthielemann/kestrel-core'
import FieldText from '../components/field/Text.vue'
import FieldNumber from '../components/field/Number.vue'
import FieldBoolean from '../components/field/Boolean.vue'
import FieldJson from '../components/field/Json.vue'
import FieldChoice from '../components/field/Choice.vue'
import FieldRelation from '../components/field/Relation.vue'
import FieldLink from '../components/field/Link.vue'
import FieldSlug from '../components/field/Slug.vue'

/** Field types with a widget so far. Each later slice adds its entry. */
export const fieldComponents: Partial<Record<FieldType, Component>> = {
  text: FieldText,
  slug: FieldSlug,
  number: FieldNumber,
  boolean: FieldBoolean,
  json: FieldJson,
  choice: FieldChoice,
  relation: FieldRelation,
  link: FieldLink,
  // Async-loaded so their heavy deps never enter the base editor chunk — they load only when a field of
  // that type actually renders. richtext pulls in all of TipTap (the single heaviest dep group); datetime
  // pulls reka-ui + @internationalized/date.
  datetime: defineAsyncComponent(() => import('../components/field/Datetime.vue')),
  richtext: defineAsyncComponent(() => import('../components/field/Richtext.vue')),
  // Async-loaded to break the registry → Repeater → Renderer → registry import cycle.
  repeater: defineAsyncComponent(() => import('../components/field/Repeater.vue')),
}

export const resolveFieldComponent = (type: FieldType): Component | undefined => fieldComponents[type]

/** Register a field widget for a type (domain layers call this from a plugin). Mutates the singleton. */
export function registerFieldComponent(type: FieldType, component: Component): void {
  fieldComponents[type] = component
}
