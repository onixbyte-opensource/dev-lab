import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import mermaid from "mermaid"
import Seo from "@/components/seo"

// HTML labels render as foreignObject, which taints the canvas during raster
// exports; SVG-text labels keep the preview pixel-identical to the exported file.
// themeCSS makes edge-label backgrounds opaque: the default 50% opacity lets the
// edge line show through the label and strike through the text in exports.
mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  htmlLabels: false,
  themeVariables: { edgeLabelBackground: "#ffffff" },
  themeCSS: ".edgeLabel rect { opacity: 1 !important; }",
})

const DEFAULT_DIAGRAM = `flowchart LR
    A[Client] -->|HTTPS| B[Server]
    B --> C[(Database)]
    B --> D{Cache}
    D -->|Hit| B
    D -->|Miss| C`

const RENDER_DEBOUNCE_MS = 400
const EXPORT_SCALE = 2

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function convertForeignObjectsToText(svgDocument: Document) {
  const svgNamespace = "http://www.w3.org/2000/svg"

  for (const foreignObject of Array.from(svgDocument.getElementsByTagName("foreignObject"))) {
    const x = Number(foreignObject.getAttribute("x") ?? 0)
    const y = Number(foreignObject.getAttribute("y") ?? 0)
    const width = Number(foreignObject.getAttribute("width") ?? 0)
    const height = Number(foreignObject.getAttribute("height") ?? 0)
    const className = foreignObject.querySelector("[class]")?.getAttribute("class")

    const lines: string[] = []
    let currentLine = ""
    const visit = (node: Node) => {
      if (node.nodeName === "br") {
        lines.push(currentLine)
        currentLine = ""
        return
      }
      if (node.nodeType === Node.TEXT_NODE) {
        currentLine += node.nodeValue ?? ""
        return
      }
      for (const child of Array.from(node.childNodes)) visit(child)
    }
    for (const child of Array.from(foreignObject.childNodes)) visit(child)
    lines.push(currentLine)

    const text = svgDocument.createElementNS(svgNamespace, "text")
    text.setAttribute("x", String(x + width / 2))
    text.setAttribute("y", String(y + height / 2))
    text.setAttribute("text-anchor", "middle")
    text.setAttribute("dominant-baseline", "central")
    if (className) text.setAttribute("class", className)

    const lineCount = Math.max(lines.length, 1)
    const lineHeight = height / lineCount
    lines.forEach((line, index) => {
      const tspan = svgDocument.createElementNS(svgNamespace, "tspan")
      tspan.setAttribute("x", String(x + width / 2))
      tspan.setAttribute(
        "dy",
        index === 0 ? String(((index - (lineCount - 1) / 2) * lineHeight).toFixed(2)) : String(lineHeight.toFixed(2))
      )
      tspan.textContent = line
      text.appendChild(tspan)
    })

    foreignObject.replaceWith(text)
  }
}

async function rasteriseSvg(svgString: string, mimeType: "image/png" | "image/jpeg"): Promise<Blob> {
  const svgDocument = new DOMParser().parseFromString(svgString, "image/svg+xml")
  const svgElement = svgDocument.documentElement
  convertForeignObjectsToText(svgDocument)

  const viewBox = (svgElement.getAttribute("viewBox") ?? "").trim().split(/\s+/).map(Number)
  const width = viewBox.length === 4 ? viewBox[2] : svgElement.clientWidth
  const height = viewBox.length === 4 ? viewBox[3] : svgElement.clientHeight
  if (!width || !height) {
    throw new Error("Diagram has no renderable dimensions")
  }

  svgElement.setAttribute("width", String(width))
  svgElement.setAttribute("height", String(height))
  svgElement.removeAttribute("style")

  const serialisedSvg = new XMLSerializer().serializeToString(svgElement)
  const svgUrl = URL.createObjectURL(new Blob([serialisedSvg], { type: "image/svg+xml;charset=utf-8" }))

  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error("Failed to rasterise the diagram"))
      image.src = svgUrl
    })

    const canvas = document.createElement("canvas")
    canvas.width = Math.round(width * EXPORT_SCALE)
    canvas.height = Math.round(height * EXPORT_SCALE)
    const context = canvas.getContext("2d")
    if (!context) {
      throw new Error("Canvas is not supported in this browser")
    }
    if (mimeType === "image/jpeg") {
      context.fillStyle = "#ffffff"
      context.fillRect(0, 0, canvas.width, canvas.height)
    }
    context.scale(EXPORT_SCALE, EXPORT_SCALE)
    context.drawImage(image, 0, 0, width, height)

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Failed to encode the diagram"))),
        mimeType
      )
    })
  } finally {
    URL.revokeObjectURL(svgUrl)
  }
}

/**
 * Mermaid diagram page component that renders Mermaid definitions with a live
 * preview and exports diagrams as SVG, PNG or JPG.
 */
export default function Mermaid() {
  const { t } = useTranslation()
  const [mermaidInput, setMermaidInput] = useState<string>(DEFAULT_DIAGRAM)
  const [renderedSvg, setRenderedSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [zoom, setZoom] = useState(100)
  const renderIdRef = useRef(0)
  const previewAreaRef = useRef<HTMLDivElement>(null)
  const zoomTouchedRef = useRef(false)

  useEffect(() => {
    const code = mermaidInput.trim()
    if (!code) {
      setRenderedSvg(null)
      setError(null)
      return
    }

    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        await mermaid.parse(code)
        const { svg } = await mermaid.render(`mermaid-preview-${renderIdRef.current++}`, code)
        if (!cancelled) {
          setRenderedSvg(svg)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) {
          setRenderedSvg(null)
          setError((e as Error).message)
        }
      }
    }, RENDER_DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [mermaidInput])

  const baseWidth = useMemo(() => {
    if (!renderedSvg) return null
    return Number.parseFloat(renderedSvg.match(/max-width:\s*([\d.]+)px/)?.[1] ?? "") || null
  }, [renderedSvg])

  // mermaid caps the svg with an inline max-width, which would fight the zoom
  // wrapper; drop it so the wrapper width alone controls the preview scale.
  const previewSvg = useMemo(
    () => renderedSvg?.replace(/max-width:[^;"]*;?/, ""),
    [renderedSvg]
  )

  useEffect(() => {
    const container = previewAreaRef.current
    if (!renderedSvg || zoomTouchedRef.current || !container || !baseWidth) return
    const available = container.clientWidth - 48
    setZoom(Math.max(25, Math.min(100, Math.round((available / baseWidth) * 100))))
  }, [renderedSvg, baseWidth])

  const fitToWidth = useCallback(() => {
    const container = previewAreaRef.current
    if (!container || !baseWidth) return
    const available = container.clientWidth - 48
    setZoom(Math.max(25, Math.min(100, Math.round((available / baseWidth) * 100))))
  }, [baseWidth])

  const exportDiagram = useCallback(
    async (format: "svg" | "png" | "jpg") => {
      if (!renderedSvg || exporting) return

      setExporting(true)
      try {
        if (format === "svg") {
          downloadBlob(
            new Blob([renderedSvg], { type: "image/svg+xml;charset=utf-8" }),
            "mermaid-diagram.svg"
          )
        } else {
          const blob = await rasteriseSvg(renderedSvg, format === "png" ? "image/png" : "image/jpeg")
          downloadBlob(blob, `mermaid-diagram.${format}`)
        }
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setExporting(false)
      }
    },
    [renderedSvg, exporting]
  )

  return (
    <div className="h-full flex gap-4 overflow-hidden">
      <Seo
        title={t("seo.mermaid.title")}
        description={t("seo.mermaid.description")}
        path="/mermaid"
      />
      {/* Left panel - 30% */}
      <div className="w-[30%] bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden flex flex-col min-h-0">
        <div className="bg-slate-50 px-4 py-2 border-b border-slate-200 shrink-0">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            {t("mermaid.source")}
          </span>
        </div>
        <textarea
          className="flex-1 p-4 font-mono text-sm leading-6 resize-none overflow-auto bg-transparent text-slate-900 outline-none placeholder:text-slate-400"
          value={mermaidInput}
          onChange={(e) => setMermaidInput(e.target.value)}
          placeholder={t("mermaid.placeholder")}
          spellCheck={false}
        />
      </div>

      {/* Right visualisation panel - 70% */}
      <div className="w-[70%] bg-white rounded-xl shadow-sm border border-slate-200 flex flex-col overflow-hidden min-h-0">
        <div className="bg-slate-50 px-4 py-2 border-b border-slate-200 flex justify-between items-center shrink-0">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            {t("mermaid.preview")}
          </span>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="range"
              min={25}
              max={400}
              step={5}
              value={zoom}
              onChange={(e) => {
                zoomTouchedRef.current = true
                setZoom(Number(e.target.value))
              }}
              className="w-28 accent-indigo-600"
              aria-label={t("mermaid.zoom")}
            />
            <span className="text-xs font-medium text-slate-500 tabular-nums w-10 text-right">
              {zoom}%
            </span>
            <button
              onClick={fitToWidth}
              disabled={!previewSvg}
              className="text-xs font-medium px-2.5 py-1 border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colours">
              {t("mermaid.fit")}
            </button>
            <button
              onClick={() => exportDiagram("svg")}
              disabled={!renderedSvg || exporting}
              className="text-xs font-medium px-3 py-1 bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colours">
              {t("mermaid.exportSvg")}
            </button>
            <button
              onClick={() => exportDiagram("png")}
              disabled={!renderedSvg || exporting}
              className="text-xs font-medium px-3 py-1 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colours">
              {t("mermaid.exportPng")}
            </button>
            <button
              onClick={() => exportDiagram("jpg")}
              disabled={!renderedSvg || exporting}
              className="text-xs font-medium px-3 py-1 bg-violet-500 text-white rounded-lg hover:bg-violet-600 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colours">
              {t("mermaid.exportJpg")}
            </button>
          </div>
        </div>

        <div ref={previewAreaRef} className="flex-1 overflow-auto p-6 flex min-h-0">
          {error ? (
            <div className="m-auto bg-red-50 text-red-600 p-4 rounded-lg border border-red-100 text-xs max-w-full break-words">
              <strong>{t("mermaid.error")}</strong> {error}
            </div>
          ) : previewSvg ? (
            <div
              className="m-auto shrink-0 [&>svg]:w-full [&>svg]:h-auto"
              style={{ width: baseWidth ? `${(baseWidth * zoom) / 100}px` : `${zoom}%` }}
              dangerouslySetInnerHTML={{ __html: previewSvg }}
            />
          ) : (
            <p className="m-auto text-sm text-slate-400">{t("mermaid.empty")}</p>
          )}
        </div>
      </div>
    </div>
  )
}
