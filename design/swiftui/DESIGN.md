# Design System Strategy: The Elevated Desktop Experience

## 1. Overview & Creative North Star: "The Digital Atheneum"
This design system moves away from the "flat web" and toward a high-end, editorial desktop environment. Our Creative North Star is **"The Digital Atheneum"**—a space that feels curated, architectural, and profoundly calm. 

We reject the "template" look of standard macOS apps by embracing **Intentional Asymmetry**. Instead of rigid, centered grids, we use weighted sidebars and offset content blocks to create a sense of movement. We break the monotony of standard layouts by overlapping glass layers and using high-contrast typography scales (e.g., pairing a massive `display-lg` headline with a tiny, refined `label-sm` metadata tag). The goal is an interface that feels like a premium physical object rather than a digital screen.

---

### 2. Colors & Tonal Depth
Our palette is rooted in a refined "Apple Blue" (`primary`), but its power comes from the sophisticated neutrals surrounding it.

*   **The "No-Line" Rule:** 1px solid borders are strictly prohibited for sectioning. Structural boundaries must be defined solely through background shifts. For example, a sidebar using `surface-container-low` should sit against a main content area of `surface`.
*   **Surface Hierarchy & Nesting:** Think of the UI as stacked sheets of fine vellum.
    *   **Level 0 (Base):** `surface` (#faf9fe)
    *   **Level 1 (Sections):** `surface-container-low` (#f4f3f8)
    *   **Level 2 (Interactive Cards):** `surface-container-lowest` (#ffffff)
*   **The "Glass & Gradient" Rule:** To provide "soul," use `surface-tint` at 5-10% opacity with a `backdrop-blur` (20pt–40pt) for floating utility panels. For primary CTAs, do not use flat fills; use a subtle linear gradient from `primary` (#0058bc) to `primary_container` (#0070eb) at a 135° angle to create a "jewel" effect.

---

### 3. Typography: Editorial Authority
We utilize a simulated SF Pro (Inter) to provide a familiar yet distinct desktop feel. The hierarchy is designed to guide the eye through scale, not just weight.

*   **The Power Gap:** Use `display-lg` (3.5rem) for landing moments, immediately followed by `body-md` (0.875rem) for descriptions. This "Power Gap" in sizing creates an upscale, editorial rhythm.
*   **Hierarchy Roles:**
    *   **Display/Headline:** Use `headline-lg` (2rem) for page titles. These should have a slight negative letter-spacing (-0.02em) to feel "tight" and professional.
    *   **Titles:** `title-md` (1.125rem) serves as the primary anchor for card headings.
    *   **Body:** `body-md` is our workhorse. Ensure a line-height of 1.5x for maximum readability.
    *   **Labels:** `label-sm` (0.6875rem) should be used in all-caps with +0.05em letter spacing for category tags or secondary metadata.

---

### 4. Elevation & Depth: Tonal Layering
We move beyond shadows to define space.

*   **The Layering Principle:** Depth is achieved by "stacking" the surface tiers. A `surface-container-highest` navigation bar should appear to "float" over a `surface` background simply through its tonal contrast.
*   **Ambient Shadows:** If a shadow is required (e.g., a detached popover), it must be "Ambient." Use `on-surface` at 4% opacity with a 32px blur and an 8px Y-offset. This mimics natural light rather than a digital drop-shadow.
*   **The "Ghost Border" Fallback:** For high-density data where separation is vital, use a "Ghost Border": `outline-variant` (#c1c6d7) at **15% opacity**. It should be felt, not seen.
*   **Glassmorphism:** Use `primary_container` with 10% opacity and a heavy blur for "active" sidebar states, allowing the desktop wallpaper or underlying content to provide a vibrant, organic texture.

---

### 5. Components
Each component must feel intentional and substantial.

*   **Buttons:**
    *   **Primary:** Gradient fill (`primary` to `primary-container`), `DEFAULT` (0.5rem) rounded corners, white text.
    *   **Secondary:** No fill. `surface-container-high` background on hover only. 
*   **Cards:** Forbid divider lines. Use `spacing-8` (2rem) of vertical white space to separate card groups. Use `surface-container-lowest` for the card body to make it "pop" against a `surface-container-low` background.
*   **Inputs:** Use `surface-container-highest` for the input field background. Upon focus, transition the background to `surface-container-lowest` and apply a 2px `ghost-border` using the `primary` color.
*   **Navigation Rails:** Use `surface-dim` for the background and `primary` for the active indicator. The indicator should be a vertical "pill" (`full` roundedness) rather than a simple color change.
*   **Tooltips:** High-contrast `inverse-surface` with `label-md` typography. Use a 12px blur on the background to soften the edge.

---

### 6. Do’s and Don’ts

#### **Do:**
*   **Do** use asymmetrical margins. A 64px left margin and a 32px right margin can make a dashboard feel like a high-end magazine.
*   **Do** use `primary-fixed-dim` for subtle background highlights in dark mode to maintain "vibrancy without glare."
*   **Do** leverage `spacing-12` and `spacing-16` for "breathable" layouts.

#### **Don’t:**
*   **Don’t** use 100% black (#000000). Always use `on-surface` (#1a1b1f) to maintain a soft, premium ink-on-paper look.
*   **Don’t** use dividers or separators. If you feel you need a line, use a 24px gap of white space instead.
*   **Don’t** use "Standard" 44pt button heights. Use our `spacing-10` (40px) for a more refined, desktop-first precision.