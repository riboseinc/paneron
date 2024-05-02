/** @jsx jsx */
/** @jsxFrag React.Fragment */

import { jsx, css } from '@emotion/react';
import styled from '@emotion/styled';
import React, { memo, useContext, useMemo } from 'react';
import { Classes, Colors, NonIdealState } from '@blueprintjs/core';
import { INITIAL_GLOBAL_SETTINGS } from '@riboseinc/paneron-extension-kit/settings';
import { NavbarButton } from '@riboseinc/paneron-extension-kit/widgets/Navbar2';

import { getAppVersion, refreshMainWindow } from 'common';
import { useSettings } from './settings';

import Nav from './Nav';
import ContextProvider, { Context } from './context';
import Dataset from './Dataset';
import WelcomeScreen from './WelcomeScreen';
import GlobalSettingsForm from './GlobalSettingsForm';


const MainWindow: React.VoidFunctionComponent<Record<never, never>> = memo(function () {
  const { value: { settings: { mainNavbarPosition } } } =
    useSettings('global', INITIAL_GLOBAL_SETTINGS);

  const { value: { version, isPackaged } } =
    getAppVersion.renderer!.useValue({}, { version: '' });

  return useMemo(() => {
    const Frag = isPackaged ? React.Fragment : React.StrictMode;
    return (
      <Frag>
        <ContextProvider>
          <div css={css`position: absolute; inset: 0; box-sizing: border-box; overflow: hidden;`}>
            <MainView
              css={css`
                flex: 1;
                overflow: hidden;
                background: ${Colors.WHITE};
                .bp4-dark & {
                  background: ${Colors.DARK_GRAY1};
                }
              `}
              className={Classes.ELEVATION_3}
            />
            <Navbar
              isPackaged={isPackaged}
              version={version}
            />
          </div>
        </ContextProvider>
      </Frag>
    );
  }, [mainNavbarPosition, isPackaged, version]);
});


const Navbar: React.FC<{ version: string, isPackaged?: boolean }> =
memo(function ({ version, isPackaged }) {
  const { state: { view }, dispatch } = useContext(Context);

  const { value: { settings: { mainNavbarPosition } } } =
    useSettings('global', INITIAL_GLOBAL_SETTINGS);

  return (
    <Nav
        anchor={mainNavbarPosition === 'top'
          ? 'start'
          : 'end'}
        className={mainNavbarPosition === 'bottom'
          ? Classes.ELEVATION_2
          : Classes.ELEVATION_1}
        css={css`
          position: absolute;
          ${mainNavbarPosition === 'bottom'
            ? 'bottom: 0'
            : 'top: 0'};
          right: -15px; left: -15px;
          height: ${NAV_HEIGHT_PX}px;
          z-index: 2;`}>
      <NavbarButton
        title="Host application version"
        text={isPackaged ? `v${version}` : 'DEV'}
        disabled
      />
      <NavbarButton
        icon="refresh"
        title="Refresh window"
        onClick={() => refreshMainWindow.renderer!.trigger({})}
      />
      <NavbarButton
        icon="settings"
        title="Settings"
        active={view === 'settings'}
        onClick={() => dispatch({ type: view === 'settings' ? 'close-settings' : 'open-settings' })}
      />
    </Nav>
  );
});


const MainView: React.FC<{ className?: string }> =
memo(function ({ className }) {
  const { state } = useContext(Context);

  const { value: { settings: { mainNavbarPosition } } } =
    useSettings('global', INITIAL_GLOBAL_SETTINGS);

  const MAIN_VIEWS = useMemo((() => ({
    'welcome-screen': <WelcomeScreen
      className={className}
      css={css`position: absolute; inset: 0; margin: auto; height: 70vh; width: 70vw;`}
    />,
    'settings': <GlobalSettingsForm
      className={className}
      css={css`overflow-y: auto !important; display: flex; flex-flow: column nowrap;`}
    />,
    'dataset': <Dataset
      className={className}
      showExportOptions={state.view === 'dataset' && state.export ? true : undefined}
    />,
    'fallback': <NonIdealState
      title="Unknown view"
      icon="heart-broken"
      description="Please try refreshing the window."
    />,
  })), [className]);

  return (
    <MainViewWrapper
        css={css`
          ${mainNavbarPosition === 'bottom'
              ? `bottom: ${NAV_HEIGHT_PX}px; top: 0;`
              : `top: ${NAV_HEIGHT_PX}px; bottom: 0;`}
        `}>
      {MAIN_VIEWS[state.view] ?? MAIN_VIEWS.fallback}
    </MainViewWrapper>
  );
});


const NAV_HEIGHT_PX = '24';


const MainViewWrapper = styled.div`
  position: absolute; right: 0; left: 0;
  display: flex;
  flex-flow: column nowrap;
  z-index: 1;
  overflow: hidden;
  background: ${Colors.LIGHT_GRAY2};
  .bp4-dark & {
    background: ${Colors.DARK_GRAY2};
  }
`;


export default MainWindow;
