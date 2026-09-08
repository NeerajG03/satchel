# How JEFF became Satchel

Discussion synthesis through 8 September 2026. This is a record of the reasoning, not a reconstructed verbatim transcript.

## 1. Questioning the wrapper

The user asked what JEFF enabled and then challenged whether native Codex and Claude Code interfaces made much of its wrapper redundant. Centralizing tasks, providers, memory, skills, and agents was valuable, but maintaining a complicated runtime needed justification.

The discussion moved toward continuity: useful context should remain available when starting a new chat or changing provider, device, or environment. Shared durable records are a more realistic promise than identical hidden model state or every conversation automatically appearing everywhere.

## 2. Comparing the porting proposals

The Codex report examined ownership, permissions, corrections, migration, and evidence. The alternative Claude porting map offered a more concrete repository-centered shape and questioned whether the report left too many choices to a pilot.

The user supplied both a comparison review and a section-by-section revision. Important corrections included proper permission boundaries, treating skill instructions separately from execution, richer handoffs with code state and validation, typed task attributes, and avoiding premature closure of multi-repo tasks.

The comparison's proposed scheduled curator and retained persona scopes were overtaken by explicit user decisions. Its blanket queue deletion, automatic persona-memory remapping, duplicate task authorities, and automatic retirement of useful Python tools were not incorporated as requirements.

## 3. Removing personas and the curator

The user said a curator was unnecessary to get started and personas were not useful. The revised direction used explicit direct memory saves and corrections, with no proposal queue or automatic extraction. Useful old knowledge should move by meaning into personal, repository, project, or skill content.

The cost was acknowledged: people may need to ask explicitly for a save. Measuring that friction is preferable to silently recreating the curation system.

## 4. Defining the companion

The user requested a complete web and Android mockup, then clarified that the application should help configure the service and setup that makes existing agents more useful. Conversations and execution remain in those apps. The companion provides access, memory, project, skill, and troubleshooting views.

Native Android packaging versus a responsive web implementation was discussed but not finalized. The visual prototype does not establish a shipped Android application.

## 5. Keeping source integrations small

The user proposed third-party plugins for syncing external task sources, with GitHub Issues built in and Notion excluded. They then clarified that this extension system should come later: V1 needs a backend prepared for extension, not a plugin product.

The resulting boundary is GitHub-only task operations behind an internal service/backend interface. Marketplace, loader, SDK, provider field mapping, and synchronization are deferred.

## 6. Rejecting generic visual design

The user wanted clean, considered light and dark themes, liked the broad layout, and rejected the initial warm/forest and subsequent cobalt/graphite studies as uninspiring. They required external research and user vetting before broad UI changes.

The reference exploration mentioned Linear, Raycast, Things, Flighty, and Craft. It did not end in an approved alternative from that research. Those references remain background, not proof that the current prototype was derived from them or approved through a completed comparison.

## 7. The notebook and hardware handoff

The user supplied a redesigned artifact and asked for review. Its warm paper, serif content, switches, LEDs, and index tabs gave the product a physical, personal feel. The handoff also contained architectural statements about GitHub storage, one repository per project, and universal skill installation that went beyond visual design.

The review supported the visual direction and identified gaps: missing true dark mode, phone saves coupled to Claude permissions, rotated navigation and keyboard accessibility, crowded scope selection, visible correction history at scale, and unclear automatic-access versus manual-handoff semantics. Sample content also conflicted with the handoff's latest storage decision.

The user explicitly clarified that the revamp was principally a look-and-feel overhaul and that functionality, project/skill definitions, and installation mechanisms were unfinished. That clarification prevents the prototype from becoming the product specification by accident.

## 8. Native plugin distribution and the name

The user supplied OpenAI and Claude Code plugin documentation and proposed supporting those platforms. This introduced a second meaning of plugin: distributing Satchel to existing AI apps, distinct from future third-party task-source extensions inside Satchel.

The intended shape became a hosted service with companion interfaces and native ecosystem integrations. The phrase “your stuff anywhere” captured the aspiration, with actual supported surfaces and execution limits still to verify.

Naming explored a personal notebook and portable kit. Satchel, Fieldcase, Commonplace, and Folio were discussed. Existing related uses of Satchel, Commonplace, and Folio were reported. The user selected **Satchel**. A private GitHub repository was created with a README and the working line “Your work, with you.” No public availability or trademark determination was made.

## 9. This collection

The user asked for `docs/` and `design/`, all prior information, and a proper explanation of the product. The current collection preserves source artifacts unchanged and provides a current synthesis with explicit decision statuses. It does not choose every storage mechanism, deploy a service, migrate personal/work records, or apply a new UI revision.
