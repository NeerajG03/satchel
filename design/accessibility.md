# Accessibility checklist

17 September 2026. Tick every line before a screen is done. The Components board shows the intended look.

## Structure

- [ ] One `<h1>` per page. Headings in order. Eyebrows are `<span>`, not headings.
- [ ] Rail is a `<nav aria-label="Destinations">` of `<a href>` with `aria-current="page"` on the current one.
- [ ] Every page has a `<main>`. The footer readout has `role="status"` (polite live region). Errors have `role="alert"`.
- [ ] Sheets are `<dialog>` or `role="dialog"` with `aria-modal`, a labelled heading, focus trapped, Escape closes, focus returns to the opener.
- [ ] The scope picker is a `<button aria-expanded aria-haspopup="listbox">` and a `role="listbox"` with `role="option"` rows; arrow keys move, Enter selects, Escape closes, typing filters.
- [ ] Segments are a `role="tablist"` or a group of links with `aria-current`. Either is fine; be consistent.
- [ ] Stepper is a list with the current state marked `aria-current="step"`.

## Controls

- [ ] Every interactive element is a native `<button>`, `<a href>`, `<input>`, `<select>` or `<textarea>`. Nothing clickable on `div` or `span`.
- [ ] Every field has a visible `<label>`. Hint text is linked with `aria-describedby`.
- [ ] Icon-only buttons have `aria-label`.
- [ ] Minimum target 44 px tall for rail items and hardware keys, 40 px for paper controls, 32 px for small buttons inside a row that also has a larger primary action.
- [ ] Disabled controls say why nearby (the picker lock message, the Allow button on consent).

## Focus

- [ ] Visible ring on every control: 3 px `--accent` on paper, 3 px `--orange` on hardware, 3 px offset. `:focus-visible`, never removed.
- [ ] Tab order follows reading order. Sheets and the picker trap focus while open.
- [ ] After a save, focus moves to the new entry or stays in the composer; it never falls to `<body>`.

## Colour and contrast

- [ ] Body text on paper ≥ 4.5:1. Muted `#6B6257` on paper is 5.2:1. Accent `#B8451A` is 4.6:1.
- [ ] Text on hardware ≥ 4.5:1. `#EEE7DB` on `#26231F` passes; `#A79E90` is for 11 px mono readouts only and sits next to a stronger label.
- [ ] Headings at 24 px and above ≥ 3:1.
- [ ] No state is carried by colour alone. Every LED has a word. Every chip has text. Blocked rows have the reason.
- [ ] Orange is never used as text on paper.

## Motion

- [ ] Every transition and animation uses the tokens. Under `prefers-reduced-motion: reduce` everything becomes a swap.
- [ ] Nothing loops except the verify light, and it runs once per verification.
- [ ] No content moves while the user is reading it, other than the list settling in after an action they took.

## Text

- [ ] Names, titles and descriptions wrap. Nothing is clipped with `overflow: hidden` except single-line picker rows, which carry the full text in `title`.
- [ ] Page works at 200% browser zoom without horizontal scroll inside the paper.
- [ ] Dates are written out ("Wed 17 Sep") and carry a full `<time datetime>`.
- [ ] Copy uses plain words. See [copy.md](copy.md).

## Errors

- [ ] Errors appear next to the thing that failed and are announced once.
- [ ] Each says what failed, what is safe, and one thing to do.
- [ ] Destructive confirmations (Forget, Revoke, Move to Blocked) need a second click and never run on Enter from a text field.
