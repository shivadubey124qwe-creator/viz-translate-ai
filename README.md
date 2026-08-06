# MangaLens AI Reader

MASTER PROMPT — MangaLens AI



You are an expert Android software architect, Kotlin developer, AI engineer, computer vision engineer, graphics programmer, OCR specialist, UI/UX designer, and systems architect.



Your goal is to build a production-quality Android application called MangaLens AI.



Do NOT create a prototype, demo, proof of concept, placeholder, mock implementation, simplified version, or pseudo-code.



Every class, feature, and module must be production-ready.



Maintain a single Android Studio project throughout development.



Whenever a feature depends on another feature, implement the dependency first.



Never rewrite previous modules unless necessary.



Maintain clean architecture and production coding standards.



---



Vision



Create the world's best manga, manhwa, manhua, comic, and webtoon translator.



The translated pages should appear as if they were officially localized.



The user should almost never wait for translation.



The application should feel native, fast, intelligent, and polished.



---



Core Features



Built-in Reader



The application should include its own reader instead of relying on Chrome.



Support:



- Built-in browser using Android WebView or Chromium

- CBZ

- ZIP

- PDF

- Local image folders

- Plugin-based online sources similar to Mihon



The browser should detect manga pages automatically.



---



Reader Pipeline



When a page is displayed:



Detect page



↓



OCR



↓



Language detection



↓



Bubble detection



↓



SFX detection



↓



Context analysis



↓



Translation memory lookup



↓



Official translation lookup (when available through supported APIs or user-provided sources)



↓



AI translation



↓



Image inpainting



↓



Typography reconstruction



↓



Layout reconstruction



↓



Rendering



↓



Caching



↓



Display



---



Predictive Translation



While the user reads Page N:



Automatically process:



Page N+1



Page N+2



Page N+3



Background translation should always stay ahead of the reader.



---



Whole Chapter Translation



As soon as a chapter is opened:



Translate the remaining pages in the background.



Cache them locally.



Never interrupt reading.



---



Next Chapter Prediction



Near the end of the current chapter:



If the next chapter is available through the current source or plugin:



Download it.



Translate it.



Render it.



Cache it.



Allow instant reading.



---



OCR



Support multiple OCR engines:



Google ML Kit



PaddleOCR



Google Cloud Vision



Tesseract



Automatically select the engine with the highest confidence.



---



AI Translation



Support:



Gemini



OpenAI



Local ONNX models



Allow switching providers.



---



Translation Memory



Maintain a database containing:



Character names



Places



Organizations



Magic



Skills



Weapons



Repeated phrases



Honorific preferences



Onomatopoeia translations



Always maintain consistency across the series.



---



AI Context Engine



Never translate a single speech bubble independently.



Analyze:



Current page



Previous pages



Following pages when available



Previous chapters



Character personalities



Story context



Relationships



Running jokes



Pronouns



Tone



Maintain contextual consistency.



---



Onomatopoeia (SFX) Engine



This is one of the highest-priority features.



Detect SFX separately from dialogue.



Recognize:



Japanese



Korean



Chinese



English



Determine:



Meaning



Emotion



Intensity



Context



Do NOT perform literal translation.



Examples:



ドン



↓



THUD



or



BOOM



depending on context.



Render translated SFX with matching perspective, rotation, size, texture, and artistic style.



---



Bubble Detection



Detect:



Speech bubbles



Thought bubbles



Narration



Signs



Captions



Determine:



Padding



Maximum font size



Alignment



Line wrapping



Vertical text



Rotated bubbles



Irregular bubbles



Never allow text overflow.



---



AI Font Recreation



Analyze the original typography:



Font family



Weight



Outline



Shadow



Glow



Gradient



Stroke



Kerning



Rotation



Perspective



Curvature



Texture



Attempt to recreate the appearance using existing fonts or vector-rendered glyphs so the translated page blends naturally into the artwork.



---



Image Inpainting



Remove only the original text.



Preserve:



Line art



Textures



Screentones



Gradients



Background details



Support:



LaMa



BrushNet



Stable Diffusion Inpainting



---



Rendering Engine



Render using:



Skia



Android Canvas



Jetpack Compose Graphics



GPU acceleration when available.



---



Cache



Store:



OCR



Translations



Typography



Rendered pages



Metadata



Panel information



Translation memory



Never reprocess an unchanged page.



---



Offline Mode



Support:



Offline OCR



Offline rendering



Offline translation using local models



Offline cache



When online:



Synchronize improved translations if available.



---



Plugin SDK



Create a plugin system for:



Reader sources



OCR providers



Translation providers



Inpainting engines



Export formats



Allow developers to add plugins without modifying the main application.



---



Export



Allow exporting translated chapters as:



PDF



CBZ



ZIP Images



Preserve artwork and layout.



---



User Interface



Material Design 3



Dark mode



Library



Reader



Translation queue



Download manager



Statistics



Performance monitor



Cache manager



Translation history



Split view



Opacity slider



Original vs translated toggle



---



Performance Goals



Cached page:



Less than 500 ms



New page:



Less than 2 seconds



Predictive translation:



Always running in background



Battery optimized



GPU accelerated where supported



---



Technology Stack



Kotlin



Jetpack Compose



MVVM



Clean Architecture



Repository Pattern



Hilt



Room



Coroutines



Flow



WorkManager



Retrofit



OkHttp



OpenCV



ML Kit



PaddleOCR



Google Cloud Vision



ONNX Runtime



Gemini API



OpenAI API



LaMa



Skia



Disk LRU Cache



Android Canvas



---



Development Process



Do NOT generate the entire application in one response.



Instead:



1. Design the complete architecture.

2. Generate the Android Studio project.

3. Implement one module at a time.

4. Keep every module production-ready.

5. Ensure every new module integrates with previous ones.

6. After each module, wait for confirmation before continuing.



The final result should be a complete Android Studio project that can be compiled, tested, extended, and maintained.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/3123a2f5-3a04-4f03-ac90-c1cb8cc2c2c7).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
