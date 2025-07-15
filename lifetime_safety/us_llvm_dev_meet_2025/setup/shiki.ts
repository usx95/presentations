import type { ShikiSetupReturn } from '@slidev/types'
import { defineShikiSetup } from '@slidev/types'

import {
  transformerNotationDiff,
  transformerNotationErrorLevel,
  transformerNotationWordHighlight
} from '@shikijs/transformers'

export default defineShikiSetup((): ShikiSetupReturn => {
  return {
    theme: 'one-dark-pro',
    transformers: [
      transformerNotationDiff(),
      transformerNotationErrorLevel(),
      transformerNotationWordHighlight()
    ]
  }
})
