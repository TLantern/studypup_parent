# Revert Viral Layout — Instructions for AI

This file tells you exactly what to undo to go back to the normal professional layout.
The viral screens are kept in place — just stop routing to them.

---

## 1. Restore `studypup/app/professional-home.tsx`

Currently it is a redirect stub that sends users to `/viral-professional-home`.
Replace the entire file with its original content by running:

```
git show $(git log --oneline studypup/app/professional-home.tsx | grep -v "viral\|redirect" | head -1 | awk '{print $1}'):studypup/app/professional-home.tsx > studypup/app/professional-home.tsx
```

Or just tell the AI: **"Restore professional-home.tsx from git to the last version before the viral redirect was added."**

---

## 2. Viral files created (DO NOT delete unless intended)

| File | Route | Purpose |
|---|---|---|
| `studypup/app/viral-professional-home.tsx` | `/viral-professional-home` | Viral home with Notario branding |
| `studypup/app/viral-professional-note-detail.tsx` | `/viral-professional-note-detail` | Viral note detail output page |
| `studypup/app/viral-transcribing.tsx` | `/viral-transcribing` | Viral transcription loading page |

---

## 3. What was changed on the viral home vs original

- Settings icon removed from header
- "My Notes" title replaced with "Notario" + logo to the left
- Notario icon added to the recording overlay screen
- No analytics tracking (trackPageViewed removed)

---

## 4. To re-enable viral layout later

Tell the AI: **"Make professional-home.tsx redirect to viral-professional-home again."**
