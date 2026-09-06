# Fixture audio

## `es-perro.wav`

The Spanish word *perro* ("dog"), said by a native speaker: `/ˈpe.ro/`, four
scored phones `p e r o`, and the trill that this whole feature exists to hear.

- **Source:** [File:Es-perro.wav](https://commons.wikimedia.org/wiki/File:Es-perro.wav)
  on Wikimedia Commons.
- **Author:** Commons user *UofG Language Modules*.
- **Licence:** [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0).
  Attribution as above; share-alike applies to the audio, not to this repo's
  code. Worth remembering if this ever stops being a private repo.
- **Changes:** downmixed and resampled to 16 kHz mono 16-bit PCM, which is the
  only rate the acoustic model accepts. Nothing else — no trimming, no gain.

It is real human speech on purpose. `say -v Paulina` was measured in the plan's
§10.3 and is **not** good enough: the model decodes the native clip essentially
perfectly and degrades on the synthetic ones, so a synthetic fixture would test
the TTS voice rather than the pipeline.

Common Voice would be the obvious source for more of these, and the plan
assumed it (§4.6) before §10.5 found it gated behind a HuggingFace token.
Commons is the ungated substitute, and its coverage is thin: of the words in
the Phase 1 verify list, only *perro* has a recording at all — `Es-casa.wav`,
`Es-cielo.wav`, `Es-jugar.wav`, `Es-guitarra.wav` and `Es-tierra.wav` are all
404. That is a Phase 5 problem (open decision 5), not a Phase 3 one.
