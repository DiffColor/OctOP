```markdown
# Design System Strategy: Neon Pulse & Deep Space

## 1. Overview & Creative North Star
**Creative North Star: The Living Light**

This design system is not a static interface; it is a breathing, nocturnal ecosystem. We are moving away from the "boxy" constraints of traditional SaaS dashboards toward a high-end, cinematic experience. By pairing a near-black void (`#0e0e0f`) with hyper-vibrant neon emitters, we create a sense of infinite depth.

The aesthetic breaks the "template" look through **intentional luminance**. We don't just use color; we use light. Elements shouldn't just sit on the screen—they should appear to glow from within, utilizing heavy soft glows and glassmorphism to simulate a futuristic HUD (Heads-Up Display) that feels both premium and ethereal.

---

## 2. Colors & Light Emission
Our palette is rooted in the contrast between the "Void" (our dark neutrals) and "Emitters" (our neon accents).

### The "No-Line" Rule
**Explicit Instruction:** Prohibit 1px solid borders for sectioning. Boundaries must be defined solely through background color shifts. Use `surface-container-low` against `surface` to define regions. Traditional lines feel "analog" and "constrained"—we want the UI to feel fluid and boundless.

### Surface Hierarchy & Nesting
Treat the UI as a series of stacked, translucent obsidian sheets.
*   **Base Layer:** `surface` (#0e0e0f) - The infinite background.
*   **Secondary Regions:** `surface-container-low` - For large sidebars or secondary content areas.
*   **Actionable Containers:** `surface-container-high` - For cards or focused modules.
*   **The "Glass & Gradient" Rule:** Floating overlays must use `surface-variant` with a 40-60% opacity and a `backdrop-filter: blur(20px)`. This creates a sophisticated "Frosted Glass" effect where the neon glows of the background bleed through the container.

### Signature Textures (Luminescent Gradients)
To achieve "visual soul," CTAs and active voice waves should never be a flat hex code. Use linear gradients:
*   **Primary Pulse:** `primary` to `primary-container` (Electric Cyan to Deep Teal).
*   **Energy Surge:** `secondary` to `secondary-container` (Vibrant Magenta to Deep Purple).

---

## 3. Typography: The Editorial Contrast
We use a high-contrast pairing to balance futuristic tech with high-end readability.

*   **Display & Headlines (Space Grotesk):** This is our "Tech" voice. Its wide apertures and geometric construction feel engineered. Use `display-lg` for AI states and `headline-md` for section headers.
*   **Body & Titles (Manrope):** This is our "Human" voice. It is highly legible and grounded. Use `body-lg` for primary interactions and `label-md` for metadata.
*   **Hierarchy Note:** Use `on-surface-variant` (dimmer grey) for secondary information to ensure the `primary` neon text elements truly "pop" as the highest priority.

---

## 4. Elevation & Depth
Depth is achieved through **Tonal Layering** and **Photometric Glows** rather than drop shadows.

*   **The Layering Principle:** Instead of a shadow, place a `surface-container-highest` card on top of a `surface-container-low` background. The subtle shift in "blackness" creates a cleaner, more modern lift.
*   **Ambient Shadows (The Glow):** When an element must "float" (like a voice orb), use a shadow that matches the element's color. 
    *   *Example:* A `primary` cyan button should have a 20px blur shadow using `primary` at 15% opacity. This mimics how real neon lights illuminate their surroundings.
*   **The "Ghost Border" Fallback:** If a container needs a edge (e.g., in complex glass overlays), use `outline-variant` at 10% opacity. It should be felt, not seen.

---

## 5. Components

### The Voice Wave (Signature Component)
The centerpiece of the UI. It should utilize the `primary` (cyan) and `secondary` (magenta) tokens. Use varying opacities and `blur` filters to create a "maximized glow" effect where the waves overlap, creating white-hot intersections.

### Buttons
*   **Primary:** Background gradient from `primary` to `primary-dim`. No border. High-glow ambient shadow. Text color: `on-primary`.
*   **Secondary:** Ghost style. No background fill. `outline` at 20% opacity. Text color: `primary`.
*   **Tertiary:** `surface-variant` background, low contrast, for utility actions.

### Cards & Lists
*   **Strict Rule:** No dividers. Use 24px - 32px of vertical whitespace to separate items. 
*   **Hover State:** Shift the background from `surface-container-high` to `surface-bright`.

### Inputs
*   **Field:** `surface-container-lowest` (pure black) background. 
*   **Focus State:** The "Ghost Border" becomes 40% opacity `primary`, with a subtle 4px outer glow.

### Glass Tooltips
*   Use `surface-variant` with 50% opacity and `backdrop-filter: blur(12px)`. This ensures readability while maintaining the "Futuristic Minimalist" aesthetic.

---

## 6. Do's and Don'ts

### Do:
*   **Do** use asymmetrical layouts. Let the voice wave bleed off the edge of the screen to suggest scale.
*   **Do** use `9999px` (full) roundedness for almost everything. Sharp corners feel "old-world" in this system.
*   **Do** lean into "Pure Black" (`#000000`) for nested containers to create extreme contrast with neon elements.

### Don't:
*   **Don't** use 100% opaque borders. They kill the "light" and make the UI look like a wireframe.
*   **Don't** use standard grey shadows. Shadows in this world are dark-tinted or glowing—never neutral grey.
*   **Don't** overcrowd. This system requires significant "Negative Space" to let the glows breathe. If the screen feels busy, increase the padding.

---

**Director's Closing Note:** Always remember—the background isn't "empty space"; it's the atmosphere. Every neon element is a light source. Design as if you are lighting a scene in a film, not just placing buttons on a page.