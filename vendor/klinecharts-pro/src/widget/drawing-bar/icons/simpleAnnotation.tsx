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

// Fork Kai: icono de la herramienta de texto / anotación (simpleAnnotation).
// Una "T" sobre una línea con punta de flecha (evoca el marcador de anotación).
export default () => (
  <svg class="icon-overlay" viewBox="0 0 22 22">
    <path d="M6 3h10v2.2H12.1V13h-2.2V5.2H6V3z" stroke-opacity="0" fill-rule="evenodd" fill-opacity="1"/>
    <path d="M11 14.2l3 3.6h-6l3-3.6z" stroke-opacity="0" fill-rule="evenodd" fill-opacity="1"/>
    <path d="M10.2 17.4h1.6V21h-1.6z" stroke-opacity="0" fill-rule="evenodd" fill-opacity="1"/>
  </svg>
)
