/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  CSSResultGroup,
  LitElement,
  PropertyValues,
  TemplateResult,
  html,
  unsafeCSS,
} from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { styleMap } from 'lit/directives/style-map.js';
import { until } from 'lit/directives/until.js';
import {
  HomeAssistant,
  LovelaceCardEditor,
  getLovelace,
  handleAction,
  hasAction,
} from 'custom-card-helpers';
import screenfull from 'screenfull';
import { z } from 'zod';

import {
  ActionType,
  GetFrigateCardMenuButtonParameters,
  RawFrigateCardConfig,
  entitySchema,
  frigateCardConfigSchema,
  Actions,
} from './types.js';
import type {
  BrowseMediaQueryParameters,
  Entity,
  ExtendedHomeAssistant,
  FrigateCardConfig,
  MediaShowInfo,
  MenuButton,
  Message,
} from './types.js';

import { CARD_VERSION, REPO_URL } from './const.js';
import { FrigateCardElements } from './components/elements.js';
import { FRIGATE_BUTTON_MENU_ICON, FrigateCardMenu } from './components/menu.js';
import { View } from './view.js';
import {
  convertActionToFrigateCardCustomAction,
  createFrigateCardCustomAction,
  getActionConfigGivenAction,
  homeAssistantSignPath,
  homeAssistantWSRequest,
  isValidMediaShowInfo,
  shouldUpdateBasedOnHass,
} from './common.js';
import { localize } from './localize/localize.js';
import { renderMessage, renderProgressIndicator } from './components/message.js';

import './editor.js';
import './components/elements.js';
import './components/gallery.js';
import './components/image.js';
import './components/live.js';
import './components/menu.js';
import './components/message.js';
import './components/viewer.js';
import './components/thumbnail-carousel.js';
import './patches/ha-camera-stream.js';
import './patches/ha-hls-player.js';

import cardStyle from './scss/card.scss';
import { ResolvedMediaCache } from './resolved-media.js';
import { BrowseMediaUtil } from './browse-media-util.js';
import { isConfigUpgradeable } from './config-mgmt.js';
import { actionHandler } from './action-handler-directive.js';
import { ConditionState, conditionStateRequestHandler } from './card-condition.js';

/** A note on media callbacks:
 *
 * Media elements (e.g. <video>, <img> or <canvas>) need to callback when:
 *  - Metadata is loaded / dimensions are known (for aspect-ratio)
 *  - Media is playing / paused (to avoid reloading)
 *
 * A number of different approaches used to attach event handlers to
 * get these callbacks (which need to be attached directly to the media
 * elements, which may be 'buried' down the DOM):
 *  - Extend the `ha-hls-player` and `ha-camera-stream` to specify the required
 *    hooks (as querySelecting the media elements after rendering was a fight
 *    with the Lit rendering engine and was very fragile) .
 *  - For non-Lit elements (e.g. WebRTC) query selecting after rendering.
 *  - Library provided hooks (e.g. JSMPEG)
 *  - Directly specifying hooks (e.g. for snapshot viewing with simple <img> tags)
 */

/** A note on action/menu/ll-custom events:
 *
 * The card supports actions being configured in a number of places (e.g. tap on an
 * element, double_tap on a menu item, hold on the live view). These actions are
 * handled by handleAction() from custom-card-helpers. For Frigate-card specific
 * actions, handleAction() call will result in an ll-custom DOM event being
 * fired, which needs to be caught at the card level to handle.
 */

/* eslint no-console: 0 */
console.info(
  `%c  FRIGATE-HASS-CARD \n%c  ${localize('common.version')} ${CARD_VERSION}    `,
  'color: pink; font-weight: bold; background: black',
  'color: white; font-weight: bold; background: dimgray',
);

// This puts your card into the UI card picker dialog
(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
  type: 'frigate-card',
  name: localize('common.frigate_card'),
  description: localize('common.frigate_card_description'),
  preview: true,
  documentationURL: REPO_URL,
});

/**
 * Main FrigateCard class.
 */
@customElement('frigate-card')
export class FrigateCard extends LitElement {
  @property({ attribute: false })
  protected _hass?: HomeAssistant & ExtendedHomeAssistant;

  @state()
  public config!: FrigateCardConfig;

  protected _interactionTimerID: number | null = null;

  @property({ attribute: false })
  protected _view: View = new View();

  @state()
  protected _conditionState?: ConditionState;

  @query('frigate-card-menu')
  _menu!: FrigateCardMenu;

  @query('frigate-card-elements')
  _elements?: FrigateCardElements;

  // Whether or not media is actively playing (live or clip).
  protected _mediaPlaying = false;

  // A small cache to avoid needing to create a new list of entities every time
  // a hass update arrives.
  protected _entitiesToMonitor: string[] = [];

  // Information about the most recently loaded media item.
  protected _mediaShowInfo: MediaShowInfo | null = null;

  // Array of dynamic menu buttons to be added to menu.
  protected _dynamicMenuButtons: MenuButton[] = [];

  // The frigate camera name to use (may be manually specified or automatically
  // derived).
  // Values:
  //  - string: Camera name on the Frigate backend.
  //  - null: Attempted to find name, but failed.
  //  - undefined: Have not yet attempted to find name.
  protected _frigateCameraName?: string | null;

  // Error/info message to render.
  protected _message: Message | null = null;

  // A cache of resolved media URLs/mimetypes for use in the whole card.
  protected _resolvedMediaCache = new ResolvedMediaCache();

  /**
   * Set the Home Assistant object.
   */
  set hass(hass: HomeAssistant & ExtendedHomeAssistant) {
    this._hass = hass;

    // Manually set hass in the menu & elements. This is to allow these to
    // update, without necessarily re-rendering the entire card (re-rendering
    // interrupts clip playing).
    if (this._hass) {
      if (this._menu) {
        this._menu.hass = this._hass;
      }
      if (this._elements) {
        this._elements.hass = this._hass;
      }
    }
  }

  /**
   * Get the card editor element.
   * @returns A LovelaceCardEditor element.
   */
  public static async getConfigElement(): Promise<LovelaceCardEditor> {
    return document.createElement('frigate-card-editor');
  }

  /**
   * Get a stub basic config using the first available camera of any kind.
   * @param _hass The Home Assistant object.
   * @param entities The entities available to Home Assistant.
   * @returns A valid stub card configuration.
   */
  public static getStubConfig(
    _hass: HomeAssistant,
    entities: string[],
  ): FrigateCardConfig {
    const cameraEntity = entities.find((element) => element.startsWith('camera.'));
    return {
      camera_entity: cameraEntity,
    } as FrigateCardConfig;
  }

  /**
   * Generate the state used to evaluate conditions.
   */
  protected _generateConditionState(): void {
    this._conditionState = {
      view: this._view,
      fullscreen: screenfull.isEnabled && screenfull.isFullscreen,
    };
  }

  /**
   * Get a FrigateCard MenuButton given a set of parameters.
   * @param params Menu button parameters.
   * @returns A MenuButton.
   */
  protected _getFrigateCardMenuButton(
    params: GetFrigateCardMenuButtonParameters,
  ): MenuButton {
    return {
      type: 'custom:frigate-card-menu-icon',
      title: params.title,
      icon: params.icon,
      style: params.emphasize ? FrigateCardMenu.getEmphasizedStyle() : {},
      tap_action: params.tap_action
        ? createFrigateCardCustomAction(params.tap_action)
        : undefined,
      hold_action: params.hold_action
        ? createFrigateCardCustomAction(params.hold_action)
        : undefined,
    };
  }

  /**
   * Get the menu buttons to display.
   * @returns An array of menu buttons.
   */
  protected _getMenuButtons(): MenuButton[] {
    const buttons: MenuButton[] = [];

    if (this.config.menu.buttons.frigate) {
      buttons.push(
        this._getFrigateCardMenuButton({
          tap_action: 'frigate',
          // Use a magic icon value that the menu will use to render the icon as
          // it deems appropriate (certain menu configurations change the menu
          // icon for the 'Frigate' button).
          icon: FRIGATE_BUTTON_MENU_ICON,
          title: localize('config.menu.buttons.frigate'),
        }),
      );
    }
    if (this.config.menu.buttons.live) {
      buttons.push(
        this._getFrigateCardMenuButton({
          tap_action: 'live',
          title: localize('config.view.views.live'),
          icon: 'mdi:cctv',
          emphasize: this._view.is('live'),
        }),
      );
    }

    if (this.config.menu.buttons.clips) {
      buttons.push(
        this._getFrigateCardMenuButton({
          tap_action: 'clips',
          hold_action: 'clip',
          title: localize('config.view.views.clips'),
          icon: 'mdi:filmstrip',
          emphasize: this._view.is('clips'),
        }),
      );
    }
    if (this.config.menu.buttons.snapshots) {
      buttons.push(
        this._getFrigateCardMenuButton({
          tap_action: 'snapshots',
          hold_action: 'snapshot',
          title: localize('config.view.views.snapshots'),
          icon: 'mdi:camera',
          emphasize: this._view.is('snapshots'),
        }),
      );
    }
    if (this.config.menu.buttons.image) {
      buttons.push(
        this._getFrigateCardMenuButton({
          tap_action: 'image',
          title: localize('config.view.views.image'),
          icon: 'mdi:image',
          emphasize: this._view.is('image'),
        }),
      );
    }
    if (this.config.menu.buttons.download && this._view.isViewerView()) {
      buttons.push(
        this._getFrigateCardMenuButton({
          tap_action: 'download',
          title: localize('config.menu.buttons.download'),
          icon: 'mdi:download',
        }),
      );
    }
    if (this.config.menu.buttons.frigate_ui && this.config.frigate.url) {
      buttons.push(
        this._getFrigateCardMenuButton({
          tap_action: 'frigate_ui',
          title: localize('config.menu.buttons.frigate_ui'),
          icon: 'mdi:web',
        }),
      );
    }
    if (this.config.menu.buttons.fullscreen && screenfull.isEnabled) {
      buttons.push(
        this._getFrigateCardMenuButton({
          tap_action: 'fullscreen',
          title: localize('config.menu.buttons.fullscreen'),
          icon: screenfull.isFullscreen ? 'mdi:fullscreen-exit' : 'mdi:fullscreen',
        }),
      );
    }
    return buttons.concat(this._dynamicMenuButtons);
  }

  /**
   * Add a dynamic (elements) menu button.
   * @param button The button to add.
   */
  public _addDynamicMenuButton(button: MenuButton): void {
    if (!this._dynamicMenuButtons.includes(button)) {
      this._dynamicMenuButtons = [...this._dynamicMenuButtons, button];
    }
    this._menu.buttons = this._getMenuButtons();
  }

  /**
   * Remove a dynamic (elements) menu button that was previously added.
   * @param target The button to remove.
   */
  public _removeDynamicMenuButton(target: MenuButton): void {
    this._dynamicMenuButtons = this._dynamicMenuButtons.filter(
      (button) => button != target,
    );
    this._menu.buttons = this._getMenuButtons();
  }

  /**
   * Get the Frigate camera name through a variety of means.
   * @returns The Frigate camera name or null if unavailable.
   */
  protected async _getFrigateCameraName(): Promise<string | null> {
    // No camera name specified, apply two heuristics in this order:
    // - Get the entity information and pull out the camera name from the unique_id.
    // - Apply basic entity name guesswork.

    if (!this._hass || !this.config) {
      return null;
    }

    // Option 1: Name specified in config -> done!
    if (this.config.frigate.camera_name) {
      return this.config.frigate.camera_name;
    }

    if (this.config.camera_entity) {
      // Option 2: Find entity unique_id in registry.
      const request = {
        type: 'config/entity_registry/get',
        entity_id: this.config.camera_entity,
      };
      try {
        const entityResult = await homeAssistantWSRequest<Entity>(
          this._hass,
          entitySchema,
          request,
        );
        if (entityResult && entityResult.platform == 'frigate') {
          const match = entityResult.unique_id.match(/:camera:(?<camera>[^:]+)$/);
          if (match && match.groups) {
            return match.groups['camera'];
          }
        }
      } catch (e: any) {
        // Pass.
      }

      // Option 3: Guess from the entity_id.
      if (this.config.camera_entity.includes('.')) {
        return this.config.camera_entity.split('.', 2)[1];
      }
    }

    return null;
  }

  /**
   * Get configuration parse errors.
   * @param error The ZodError object from parsing.
   * @returns An array of string error paths.
   */
  protected _getParseErrorPaths<T>(error: z.ZodError<T>): Set<string> | null {
    /* Zod errors involving unions are complex, as Zod may not be able to tell
     * where the 'real' error is vs simply a union option not matching. This
     * function finds all ZodError "issues" that don't have an error with 'type'
     * in that object ('type' is the union discriminator for picture elements,
     * the major union in the schema). An array of human-readable error
     * locations is returned, or an empty list if none is available. None being
     * available suggests the configuration has an error, but we can't tell
     * exactly why (or rather Zod simply says it doesn't match any of the
     * available unions). This usually suggests the user specified an incorrect
     * type name entirely. */
    const contenders = new Set<string>();
    if (error && error.issues) {
      for (let i = 0; i < error.issues.length; i++) {
        const issue = error.issues[i];
        if (issue.code == 'invalid_union') {
          const unionErrors = (issue as z.ZodInvalidUnionIssue).unionErrors;
          for (let j = 0; j < unionErrors.length; j++) {
            const nestedErrors = this._getParseErrorPaths(unionErrors[j]);
            if (nestedErrors && nestedErrors.size) {
              nestedErrors.forEach(contenders.add, contenders);
            }
          }
        } else if (issue.code == 'invalid_type') {
          if (issue.path[issue.path.length - 1] == 'type') {
            return null;
          }
          contenders.add(this._getParseErrorPathString(issue.path));
        } else if (issue.code != 'custom') {
          contenders.add(this._getParseErrorPathString(issue.path));
        }
      }
    }
    return contenders;
  }

  /**
   * Convert an array of strings and indices into a more human readable string,
   * e.g. [a, 1, b, 2] => 'a[1] -> b[2]'
   * @param path An array of strings and numbers.
   * @returns A single string.
   */
  protected _getParseErrorPathString(path: (string | number)[]): string {
    let out = '';
    for (let i = 0; i < path.length; i++) {
      const item = path[i];
      if (typeof item == 'number') {
        out += '[' + item + ']';
      } else if (out) {
        out += ' -> ' + item;
      } else {
        out = item;
      }
    }
    return out;
  }

  /**
   * Set the card configuration.
   * @param inputConfig The card configuration.
   */
  public setConfig(inputConfig: RawFrigateCardConfig): void {
    if (!inputConfig) {
      throw new Error(localize('error.invalid_configuration'));
    }

    const configUpgradeable = isConfigUpgradeable(inputConfig);
    const parseResult = frigateCardConfigSchema.safeParse(inputConfig);
    if (!parseResult.success) {
      const hint = this._getParseErrorPaths(parseResult.error);
      let upgradeMessage = '';
      if (configUpgradeable && getLovelace().mode !== 'yaml') {
        upgradeMessage = `${localize('error.upgrade_available')}. `;
      }
      throw new Error(
        upgradeMessage +
          `${localize('error.invalid_configuration')}: ` +
          (hint && hint.size
            ? JSON.stringify([...hint], null, ' ')
            : localize('error.invalid_configuration_no_hint')),
      );
    }
    const config = parseResult.data;

    if (config.test_gui) {
      getLovelace().setEditMode(true);
    }

    this._frigateCameraName = undefined;
    this.config = config;

    this._entitiesToMonitor = this.config.view.update_entities || [];
    if (this.config.camera_entity) {
      this._entitiesToMonitor.push(this.config.camera_entity);
    }
    if (this.config.view.update_force) {
      // If update force is enabled, start a timer right away.
      this._resetInteractionTimer();
    }
    this._changeView();
  }

  protected _changeView(view?: View): void {
    this._message = null;

    if (view === undefined) {
      this._view = new View({ view: this.config.view.default });
    } else {
      this._view = view;
    }
    this._generateConditionState();
  }

  /**
   * Handle a change view event.
   * @param e The change view event.
   */
  protected _changeViewHandler(e: CustomEvent<View>): void {
    this._changeView(e.detail);
  }

  /**
   * Determine whether the card should be updated.
   * @param changedProps The changed properties if any.
   * @returns True if the card should be updated.
   */
  protected shouldUpdate(changedProps: PropertyValues): boolean {
    if (!this.config) {
      return false;
    }

    if (changedProps.size > 1) {
      return true;
    }

    const oldHass = changedProps.get('_hass') as HomeAssistant | undefined;
    if (oldHass) {
      // Home Assistant pumps a lot of updates through. Re-rendering the card is
      // necessary at times (e.g. to update the 'clip' view as new clips
      // arrive), but also is a jarring experience for the user (e.g. if they
      // are browsing the mini-gallery). Do not allow re-rendering from a Home
      // Assistant update if there's been recent interaction (e.g. clicks on the
      // card) or if there is media active playing.
      if (!this.config.view.update_force && (this._interactionTimerID || this._mediaPlaying)) {
        return false;
      }
      return shouldUpdateBasedOnHass(this._hass, oldHass, this._entitiesToMonitor);
    }
    return true;
  }

  /**
   * Download media being displayed in the viewer.
   */
  protected async _downloadViewerMedia(): Promise<void> {
    if (!this._hass || !this._view.isViewerView()) {
      // Should not occur.
      return;
    }

    if (!this._view.media) {
      this._setMessageAndUpdate({
        message: localize('error.download_no_media'),
        type: 'error',
      });
      return;
    }
    const event_id = BrowseMediaUtil.extractEventID(this._view.media);
    if (!event_id) {
      this._setMessageAndUpdate({
        message: localize('error.download_no_event_id'),
        type: 'error',
      });
      return;
    }

    const path =
      `/api/frigate/${this.config.frigate.client_id}` +
      `/notifications/${event_id}/` +
      `${this._view.isClipRelatedView() ? 'clip.mp4' : 'snapshot.jpg'}` +
      `?download=true`;
    let response: string | null | undefined;
    try {
      response = await homeAssistantSignPath(this._hass, path);
    } catch (e) {
      console.error(e, (e as Error).stack);
    }

    if (!response) {
      this._setMessageAndUpdate({
        message: localize('error.download_sign_failed'),
        type: 'error',
      });
      return;
    }

    if (navigator.userAgent.startsWith("Home Assistant/")) {
      // Home Assistant companion apps cannot download files without opening a
      // new browser window.
      //
      // User-agents are specified here:
      //  - Android: https://github.com/home-assistant/android/blob/master/app/src/main/java/io/homeassistant/companion/android/webview/WebViewActivity.kt#L107
      //  - iOS: https://github.com/home-assistant/iOS/blob/master/Sources/Shared/API/HAAPI.swift#L75
      window.open(response, '_blank');
    } else {
      // Use the HTML5 download attribute to prevent a new window from
      // temporarily opening.
      const link = document.createElement('a');
      link.setAttribute('download', '');
      link.href = response;
      link.click();
      link.remove();
    }
  }

  /**
   * Handle a request for a card action.
   * @param ev The action requested.
   */
  protected _cardActionHandler(ev: CustomEvent<ActionType>): void {
    // These interactions should only be handled by the card, as nothing
    // upstream has the user-provided configuration.
    ev.stopPropagation();

    const frigateCardAction = convertActionToFrigateCardCustomAction(ev.detail);
    if (!frigateCardAction) {
      return;
    }
    const action = frigateCardAction.frigate_card_action;

    switch (action) {
      case 'frigate':
        this._changeView();
        break;
      case 'clip':
      case 'clips':
      case 'image':
      case 'live':
      case 'snapshot':
      case 'snapshots':
        this._changeView(new View({ view: action }));
        break;
      case 'download':
        this._downloadViewerMedia();
        break;
      case 'frigate_ui':
        const frigate_url = this._getFrigateURLFromContext();
        if (frigate_url) {
          window.open(frigate_url);
        }
        break;
      case 'fullscreen':
        if (screenfull.isEnabled) {
          screenfull.toggle(this);
        }
        break;
      default:
        console.warn(`Frigate card received unknown card action: ${action}`);
    }
  }

  /**
   * Get the Frigate UI URL from context.
   * @returns The URL or null if unavailable.
   */
  protected _getFrigateURLFromContext(): string | null {
    if (!this.config.frigate.url) {
      return null;
    }
    if (!this._frigateCameraName) {
      return this.config.frigate.url;
    } else if (this._view.is('live')) {
      return `${this.config.frigate.url}/cameras/${this._frigateCameraName}`;
    }
    return `${this.config.frigate.url}/events?camera=${this._frigateCameraName}`;
  }

  /**
   * Handle an action called on an element.
   * @param ev The actionHandler event.
   */
  protected _actionHandler(
    ev: CustomEvent,
    config?: {
      hold_action?: ActionType;
      tap_action?: ActionType;
      double_tap_action?: ActionType;
    },
  ): void {
    const interaction = ev.detail.action;
    const node: HTMLElement | null = ev.currentTarget as HTMLElement | null;
    if (
      config &&
      node &&
      interaction &&
      // Don't call handleAction() unless there is explicitly an action defined
      // (as it uses a default that is unhelpful for views that have default
      // tap/click actions).
      getActionConfigGivenAction(interaction, config)
    ) {
      handleAction(node, this._hass as HomeAssistant, config, ev.detail.action);
    }
    this._resetInteractionTimer();
  }

  protected _resetInteractionTimer(): void {
    if (this.config.view.timeout) {
      if (this._interactionTimerID) {
        window.clearTimeout(this._interactionTimerID);
      }
      this._interactionTimerID = window.setTimeout(() => {
        this._interactionTimerID = null;
        this._changeView();
        if (this.config.view.update_force) {
          // If force is enabled, the timer just resets and starts over.
          this._resetInteractionTimer();
        }
      }, this.config.view.timeout * 1000);
    }
  }

  /**
   * Render the card menu.
   * @returns A rendered template.
   */
  protected _renderMenu(): TemplateResult | void {
    const classes = {
      'hover-menu': this.config.menu.mode.startsWith('hover-'),
    };
    return html`
      <frigate-card-menu
        .hass=${this._hass}
        .menuConfig=${this.config.menu}
        .buttons=${this._getMenuButtons()}
        .conditionState=${this._conditionState}
        class="${classMap(classes)}"
      ></frigate-card-menu>
    `;
  }

  /**
   * Get the parameters to search for media related to the current view.
   * @returns A BrowseMediaQueryParameters object.
   */
  protected _getBrowseMediaQueryParameters(
    mediaType?: 'clips' | 'snapshots',
  ): BrowseMediaQueryParameters | undefined {
    if (
      !this._frigateCameraName ||
      !(
        this._view.isClipRelatedView() ||
        this._view.isSnapshotRelatedView() ||
        mediaType
      )
    ) {
      return undefined;
    }
    return {
      mediaType: mediaType || (this._view.isClipRelatedView() ? 'clips' : 'snapshots'),
      clientId: this.config.frigate.client_id,
      cameraName: this._frigateCameraName,
      label: this.config.frigate.label,
      zone: this.config.frigate.zone,
    };
  }

  /**
   * Handler for media play event.
   */
  protected _playHandler(): void {
    this._mediaPlaying = true;
  }

  /**
   * Handler for media pause event.
   */
  protected _pauseHandler(): void {
    this._mediaPlaying = false;
  }

  /**
   * Set the message to display and trigger an update.
   * @param message The message to display.
   * @param skipUpdate If true an update request is skipped.
   */
  protected _setMessageAndUpdate(message: Message, skipUpdate?: boolean): void {
    // Register the first message, or prioritize errors if there's pre-render competition.
    if (!this._message || (message.type == 'error' && this._message.type != 'error')) {
      this._message = message;
      if (!skipUpdate) {
        this.requestUpdate();
      }
    }
  }

  /**
   * Handle a message event to render to the user.
   * @param e The message event.
   */
  protected _messageHandler(e: CustomEvent<Message>): void {
    return this._setMessageAndUpdate(e.detail);
  }

  /**
   * Handle a new piece of media being shown.
   * @param e Event with MediaShowInfo details for the media.
   */
  protected _mediaShowHandler(e: CustomEvent<MediaShowInfo>): void {
    const mediaShowInfo = e.detail;
    // In Safari, with WebRTC, 0x0 is occasionally returned during loading,
    // so treat anything less than a safety cutoff as bogus.
    if (!isValidMediaShowInfo(mediaShowInfo)) {
      return;
    }
    let requestRefresh = false;
    if (
      this._view.isGalleryView() &&
      (mediaShowInfo.width != this._mediaShowInfo?.width ||
        mediaShowInfo.height != this._mediaShowInfo?.height)
    ) {
      requestRefresh = true;
    }

    this._mediaShowInfo = mediaShowInfo;
    if (requestRefresh) {
      this.requestUpdate();
    }
  }

  /**
   * Handler called when fullscreen is toggled.
   */
  protected _fullScreenHandler(): void {
    this._generateConditionState();
    // Re-render after a change to fullscreen mode to take advantage of
    // the expanded screen real-estate (vs staying in aspect-ratio locked
    // modes).
    this.requestUpdate();
  }

  /**
   * Component connected callback.
   */
  connectedCallback(): void {
    super.connectedCallback();
    if (screenfull.isEnabled) {
      screenfull.on('change', this._fullScreenHandler.bind(this));
    }
  }

  /**
   * Component disconnected callback.
   */
  disconnectedCallback(): void {
    if (screenfull.isEnabled) {
      screenfull.off('change', this._fullScreenHandler.bind(this));
    }
    super.disconnectedCallback();
  }

  /**
   * Determine if the aspect ratio should be enforced given the current view and
   * context.
   */
  protected _isAspectRatioEnforced(): boolean {
    const aspectRatioMode = this.config.dimensions.aspect_ratio_mode;

    // Do not artifically constrain aspect ratio if:
    // - It's fullscreen.
    // - Aspect ratio enforcement is disabled.
    // - Or aspect ratio enforcement is dynamic and it's a media view (i.e. not the gallery).

    return !(
      (screenfull.isEnabled && screenfull.isFullscreen) ||
      aspectRatioMode == 'unconstrained' ||
      (aspectRatioMode == 'dynamic' && this._view.isMediaView())
    );
  }

  /**
   * Get the aspect ratio padding required to enforce the aspect ratio (if it is
   * required).
   * @returns A padding percentage.
   */
  protected _getAspectRatioPadding(): number | null {
    if (!this._isAspectRatioEnforced()) {
      return null;
    }

    const aspectRatioMode = this.config.dimensions.aspect_ratio_mode;
    if (aspectRatioMode == 'dynamic' && this._mediaShowInfo) {
      return (this._mediaShowInfo.height / this._mediaShowInfo.width) * 100;
    }

    const defaultAspectRatio = this.config.dimensions.aspect_ratio;
    if (defaultAspectRatio) {
      return (defaultAspectRatio[1] / defaultAspectRatio[0]) * 100;
    } else {
      return (9 / 16) * 100;
    }
  }

  /**
   * Merge card-wide and view-specific actions.
   * @returns A combined set of action.
   */
  protected _getMergedActions(): Actions {
    let specificActions: Actions | undefined = undefined;

    if (this._view.is('live')) {
      specificActions = this.config.live.actions;
    } else if (this._view.isGalleryView()) {
      specificActions = this.config.event_gallery?.actions;
    } else if (this._view.isViewerView()) {
      specificActions = this.config.event_viewer.actions;
    } else if (this._view.is('image')) {
      specificActions = this.config.image?.actions;
    }
    return { ...this.config.view.actions, ...specificActions };
  }

  /**
   * Master render method for the card.
   */
  protected render(): TemplateResult | void {
    const padding = this._getAspectRatioPadding();
    const outerStyle = {};

    // Padding to force a particular aspect ratio.
    if (padding != null) {
      outerStyle['padding-top'] = `${padding}%`;
    }

    const contentClasses = {
      'frigate-card-contents': true,
      absolute: padding != null,
    };

    const actions = this._getMergedActions();

    return html` <ha-card
      .actionHandler=${actionHandler({
        hasHold: hasAction(actions.hold_action),
        hasDoubleClick: hasAction(actions.double_tap_action),
      })}
      @action=${(ev: CustomEvent) => this._actionHandler(ev, actions)}
      @ll-custom=${this._cardActionHandler.bind(this)}
    >
      ${this.config.menu.mode == 'above' ? this._renderMenu() : ''}
      <div class="container outer" style="${styleMap(outerStyle)}">
        <div class="${classMap(contentClasses)}">
          ${this._frigateCameraName == undefined
            ? until(
                (async () => {
                  this._frigateCameraName = await this._getFrigateCameraName();
                  return this._render();
                })(),
                renderProgressIndicator(),
              )
            : this._render()}
        </div>
      </div>
      ${this.config.menu.mode != 'above' ? this._renderMenu() : ''}
    </ha-card>`;
  }

  /**
   * Sub-render method for the card.
   */
  protected _render(): TemplateResult | void {
    if (!this._hass) {
      return html``;
    }
    if (!this._frigateCameraName) {
      this._setMessageAndUpdate(
        {
          message: localize('error.no_frigate_camera_name'),
          type: 'error',
        },
        true,
      );
    }

    const pictureElementsClasses = {
      'picture-elements': true,
      gallery: this._view.isGalleryView(),
    };
    const galleryClasses = {
      hidden: this.config.live.preload && !this._view.isGalleryView(),
    };
    const viewerClasses = {
      hidden: this.config.live.preload && !this._view.isViewerView(),
    };
    const liveClasses = {
      hidden: this.config.live.preload && this._view.view != 'live',
    };
    const imageClasses = {
      hidden: this.config.live.preload && this._view.view != 'image',
    };

    return html`
      <div class="${classMap(pictureElementsClasses)}">
        ${this._message ? renderMessage(this._message) : ``}
        ${!this._message && this._view.is('image')
          ? html` <frigate-card-image
              .imageConfig=${this.config.image}
              class="${classMap(imageClasses)}"
              @frigate-card:media-show=${this._mediaShowHandler}
              @frigate-card:message=${this._messageHandler}
            >
            </frigate-card-image>`
          : ``}
        ${!this._message && this._view.isGalleryView()
          ? html` <frigate-card-gallery
              .hass=${this._hass}
              .view=${this._view}
              .browseMediaQueryParameters=${this._getBrowseMediaQueryParameters()}
              class="${classMap(galleryClasses)}"
              @frigate-card:change-view=${this._changeViewHandler}
              @frigate-card:message=${this._messageHandler}
            >
            </frigate-card-gallery>`
          : ``}
        ${!this._message && this._view.isViewerView()
          ? html` <frigate-card-viewer
              .hass=${this._hass}
              .view=${this._view}
              .browseMediaQueryParameters=${this._getBrowseMediaQueryParameters()}
              .viewerConfig=${this.config.event_viewer}
              .resolvedMediaCache=${this._resolvedMediaCache}
              class="${classMap(viewerClasses)}"
              @frigate-card:change-view=${this._changeViewHandler}
              @frigate-card:media-show=${this._mediaShowHandler}
              @frigate-card:pause=${this._pauseHandler}
              @frigate-card:play=${this._playHandler}
              @frigate-card:message=${this._messageHandler}
            >
            </frigate-card-viewer>`
          : ``}
        ${
          // Note the subtle difference in condition below vs the other views in order
          // to always render the live view for live.preload mode.
          (!this._message && this._view.is('live')) || this.config.live.preload
            ? html`
                <frigate-card-live
                  .hass=${this._hass}
                  .browseMediaQueryParameters=${this._getBrowseMediaQueryParameters(
                    this.config.live.controls.thumbnails.media,
                  )}
                  .config=${this.config}
                  .preload=${this.config.live.preload && !this._view.is('live')}
                  class="${classMap(liveClasses)}"
                  @frigate-card:change-view=${this._changeViewHandler}
                  @frigate-card:media-show=${this._mediaShowHandler}
                  @frigate-card:pause=${this._pauseHandler}
                  @frigate-card:play=${this._playHandler}
                  @frigate-card:message=${this._messageHandler}
                >
                </frigate-card-live>
              `
            : ``
        }
        ${this.config.elements
          ? html`
              <frigate-card-elements
                .hass=${this._hass}
                .elements=${this.config.elements}
                .conditionState=${this._conditionState}
                @frigate-card:message=${this._messageHandler}
                @frigate-card:menu-add=${(e) => {
                  this._addDynamicMenuButton(e.detail);
                }}
                @frigate-card:menu-remove=${(e) => {
                  this._removeDynamicMenuButton(e.detail);
                }}
                @frigate-card:condition-state-request=${(ev) => {
                  conditionStateRequestHandler(ev, this._conditionState);
                }}
              >
              </frigate-card-elements>
            `
          : ``}
      </div>
    `;
  }

  /**
   * Return compiled CSS styles (thus safe to use with unsafeCSS).
   */
  static get styles(): CSSResultGroup {
    return unsafeCSS(cardStyle);
  }

  /**
   * Get the Lovelace card size.
   * @returns The Lovelace card size in units of 50px.
   */
  public getCardSize(): number {
    if (this._mediaShowInfo) {
      return this._mediaShowInfo.height / 50;
    }
    return 6;
  }
}
