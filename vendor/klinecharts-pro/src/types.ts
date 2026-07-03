/**
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at

 * http://www.apache.org/licenses/LICENSE-2.0

 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { KLineData, Styles, DeepPartial, Chart, Nullable, Overlay } from 'klinecharts'

export interface SymbolInfo {
  ticker: string
  name?: string
  shortName?: string
  exchange?: string
  market?: string
  pricePrecision?: number
  volumePrecision?: number
  priceCurrency?: string
  type?: string
  logo?: string
}

export interface Period {
  multiplier: number
  timespan: string
  text: string
}

export type DatafeedSubscribeCallback = (data: KLineData) => void

// Fork Kai: un indicador principal puede declararse sólo por su nombre
// (comportamiento original) o con `calcParams` para sobreescribir los períodos
// por defecto de la librería (p.ej. EMA 6/12/20 → 10/20/55/200).
export interface MainIndicatorSpec {
  name: string
  calcParams?: number[]
}

// Fork Kai: tipo de evento que la app recibe cuando el usuario crea / mueve /
// borra un overlay desde la DrawingBar nativa (para poder persistirlos).
export type OverlayEventType = 'created' | 'updated' | 'removed'

export interface Datafeed {
  searchSymbols (search?: string): Promise<SymbolInfo[]>
  getHistoryKLineData (symbol: SymbolInfo, period: Period, from: number, to: number): Promise<KLineData[]>
  subscribe (symbol: SymbolInfo, period: Period, callback: DatafeedSubscribeCallback): void
  unsubscribe (symbol: SymbolInfo, period: Period): void
}

export interface ChartProOptions {
  container: string | HTMLElement
  styles?: DeepPartial<Styles>
  watermark?: string | Node
  theme?: string
  locale?: string
  drawingBarVisible?: boolean
  symbol: SymbolInfo
  period: Period
  periods?: Period[]
  timezone?: string
  // Fork Kai: acepta nombres sueltos o specs con calcParams (ver MainIndicatorSpec).
  mainIndicators?: Array<string | MainIndicatorSpec>
  subIndicators?: string[]
  datafeed: Datafeed
  // Fork Kai: el buscador interno de Pro cambia sólo su signal de símbolo; este
  // callback deja que la app siga al chart (panel de orden, BUY/SELL, etc.).
  onSymbolChange?: (ticker: string) => void
  // Fork Kai: idem para el timeframe elegido desde la PeriodBar interna.
  onPeriodChange?: (period: Period) => void
  // Fork Kai: notifica overlays creados/movidos/borrados desde la DrawingBar
  // nativa para que la app pueda persistirlos.
  onOverlayEvent?: (type: OverlayEventType, overlay: Overlay) => void
}

export interface ChartPro {
  setTheme(theme: string): void
  getTheme(): string
  setStyles(styles: DeepPartial<Styles>): void
  getStyles(): Styles
  setLocale(locale: string): void
  getLocale(): string
  setTimezone(timezone: string): void
  getTimezone(): string
  setSymbol(symbol: SymbolInfo): void
  getSymbol(): SymbolInfo
  setPeriod(period: Period): void
  getPeriod(): Period
  // Fork Kai: acceso a la instancia interna de klinecharts.
  getChart(): Nullable<Chart>
}
