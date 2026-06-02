---
name: Enterprise Merchandising System
colors:
  surface: '#f7f9fb'
  surface-dim: '#d8dadc'
  surface-bright: '#f7f9fb'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f2f4f6'
  surface-container: '#eceef0'
  surface-container-high: '#e6e8ea'
  surface-container-highest: '#e0e3e5'
  on-surface: '#191c1e'
  on-surface-variant: '#434656'
  inverse-surface: '#2d3133'
  inverse-on-surface: '#eff1f3'
  outline: '#737688'
  outline-variant: '#c3c5d9'
  surface-tint: '#004ced'
  primary: '#003ec7'
  on-primary: '#ffffff'
  primary-container: '#0052ff'
  on-primary-container: '#dfe3ff'
  inverse-primary: '#b7c4ff'
  secondary: '#565e74'
  on-secondary: '#ffffff'
  secondary-container: '#dae2fd'
  on-secondary-container: '#5c647a'
  tertiary: '#3f4f65'
  on-tertiary: '#ffffff'
  tertiary-container: '#57677e'
  on-tertiary-container: '#d6e6ff'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#dde1ff'
  primary-fixed-dim: '#b7c4ff'
  on-primary-fixed: '#001452'
  on-primary-fixed-variant: '#0038b6'
  secondary-fixed: '#dae2fd'
  secondary-fixed-dim: '#bec6e0'
  on-secondary-fixed: '#131b2e'
  on-secondary-fixed-variant: '#3f465c'
  tertiary-fixed: '#d3e4fe'
  tertiary-fixed-dim: '#b7c8e1'
  on-tertiary-fixed: '#0b1c30'
  on-tertiary-fixed-variant: '#38485d'
  background: '#f7f9fb'
  on-background: '#191c1e'
  surface-variant: '#e0e3e5'
typography:
  headline-xl:
    fontFamily: Inter
    fontSize: 36px
    fontWeight: '700'
    lineHeight: 44px
    letterSpacing: -0.02em
  headline-xl-mobile:
    fontFamily: Inter
    fontSize: 28px
    fontWeight: '700'
    lineHeight: 34px
    letterSpacing: -0.01em
  headline-lg:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  headline-md:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.01em
  label-sm:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '600'
    lineHeight: 14px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  base: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  gutter: 20px
  margin: 24px
---

## Brand & Style

This design system is engineered for high-stakes decision-making and large-scale inventory management. The brand personality is **authoritative, analytical, and frictionless**, prioritizing the speed of data comprehension over decorative flair.

The visual style follows a **Modern Corporate** aesthetic. It utilizes a rigorous logical structure to organize complex information hierarchies. By combining a "Data-First" philosophy with subtle depth, the UI remains approachable for long-duration usage while maintaining the precision required for enterprise merchandising. Every element is designed to reduce cognitive load and highlight actionable insights.

## Colors

The palette is anchored by **Action Blue**, a vibrant primary used exclusively for interactive elements and primary calls to action. **Deep Navy** provides the structural foundation, used for navigation and high-level headers to instill a sense of stability. 

**Slate Grays** are employed for secondary information and iconography, creating a sophisticated gray-scale that avoids the harshness of pure black. The background strategy relies on a multi-step neutral scale (`#F8FAFC` to `#E2E8F0`) to create logical "zones" within the merchandising dashboard without relying on heavy lines.

## Typography

This design system utilizes **Inter** across all levels to ensure maximum legibility in data-dense environments. The typographic scale is optimized for information density; while headlines provide clear section entry points, the core of the experience lives in the `body-md` and `label-md` sizes.

To maintain hierarchy in complex tables, use `label-sm` in all-caps for column headers to differentiate them from the primary data points. Numerical data should be rendered with tabular figures (mono-spacing for numbers) where possible to ensure columns align perfectly during financial analysis.

## Layout & Spacing

The design system employs a **12-column fluid grid** for the main content area, allowing the dashboard to scale from laptop screens to ultra-wide monitors used in procurement offices. 

Spacing follows a **4px base unit system**, but defaults to a "Compact" density for merchandising tables (8px cell padding) and a "Comfortable" density for general settings or profile pages (16px+ padding). Gutters are fixed at 20px to ensure clear separation between data widgets. On mobile, the grid collapses to a single column with 16px side margins.

## Elevation & Depth

Visual hierarchy is established through a combination of **low-contrast outlines** and **ambient shadows**. 

1.  **Level 0 (Base):** The main canvas, using the Neutral background color.
2.  **Level 1 (Cards):** White surfaces with a 1px border in Slate Gray (#E2E8F0) and a very soft, diffused shadow (0px 1px 3px rgba(0,0,0,0.05)).
3.  **Level 2 (Interactive/Overlays):** Dropdowns and modals feature a more pronounced shadow (0px 10px 15px -3px rgba(0,0,0,0.1)) to draw focus.

Borders are the primary method of separation, while shadows are reserved for indicating interactivity or "lifted" state during drag-and-drop merchandising operations.

## Shapes

The design system uses **Soft (Level 1)** roundedness. Standard components like input fields, buttons, and alert banners feature a 0.25rem (4px) corner radius. This provides a subtle modern touch without sacrificing the professional, rigorous feel of a data-driven tool. Larger containers like cards may scale up to 0.5rem (8px) to soften the overall interface density.

## Components

### Buttons
- **Primary:** Solid Action Blue with white text. High-contrast.
- **Secondary:** Transparent background with a Slate Gray border.
- **Tertiary/Ghost:** No border, Action Blue text, used for low-priority actions in tables.

### Input Fields
Inputs use a white background with a 1px Slate Gray border. Upon focus, the border transitions to Action Blue with a subtle 2px outer glow. Labels always sit above the input field in `label-md` for maximum clarity.

### Data Tables
The heart of the application. Rows should have a subtle hover state (#F1F5F9). High-priority metrics within tables (like "Stock Level" or "Margin") should use status-colored indicators (Green for healthy, Red for critical) in a **Chip** format.

### Cards
Cards are the primary container for dashboard widgets. They must include a consistent 16px internal padding and a 1px bottom border on the header section to separate titles from the data content.

### Chips
Used for filtering and status tags. These are small, non-pill shapes (4px radius) with low-saturation background tints of the primary colors to avoid visual noise.