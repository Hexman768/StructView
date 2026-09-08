# Improve Text Pane Performance by Replacing Per-Highlight DOM Spans

## Problem

The text pane’s current highlighting implementation creates an individual `<span>` element for each highlight range. With large inputs, this can produce roughly 500,000 span elements in the DOM.

This creates substantial browser overhead:

- High memory consumption from DOM nodes and associated style/layout data.
- Slow initial rendering while the browser constructs and styles hundreds of thousands of elements.
- Expensive layout, paint, and DOM reconciliation work during scrolling, selection, resizing, and updates.
- Reduced responsiveness and potential UI freezes when rendering or changing large documents.

## Proposed Change

Replace the current text-pane highlighting/rendering mechanism with the new text-pane dependency. The dependency provides a more scalable rendering model for large text content and avoids representing every highlight as a standalone DOM node.

The integration should migrate existing text-pane behavior—including text display, highlighting, scrolling, selection, and relevant interaction behavior—to the new dependency while preserving the current user-facing experience.

## Expected Outcome

- Eliminate or drastically reduce the number of highlight `<span>` elements created.
- Improve time to first render for large documents.
- Reduce memory use and layout/paint work.
- Maintain responsive scrolling and interaction when documents contain hundreds of thousands of highlighted ranges.

## Acceptance Criteria

- Large text content with approximately 500,000 highlight ranges can be opened without severe UI degradation.
- The text pane does not create one DOM `<span>` per highlight range.
- Highlighting remains visually correct after migration.
- Existing text-pane interactions continue to work as expected.
- Performance can be compared before and after the change using a representative large-document test case.
