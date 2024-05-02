/** @jsx jsx */
/** @jsxFrag React.Fragment */

import { jsx } from '@emotion/react';
import React, { useContext, useMemo } from 'react';
import Navbar from '@riboseinc/paneron-extension-kit/widgets/Navbar2';

import { Context } from '../context';
import Breadcrumb from './Breadcrumb';
import DatasetBreadcrumb from './DatasetBreadcrumb';
import RepoBreadcrumb from './RepoBreadcrumb';


export interface NavProps {
  anchor: 'end' | 'start'
  className?: string
}


/**
 * Shows Paneron-wide nav (repository, dataset).
 * Children will be appended after the final entry and intended for additional buttons.
 */
const Nav: React.FC<NavProps> = function ({ anchor, children, className }) {
  const { state, dispatch, showMessage } = useContext(Context);

  const breadcrumbs = useMemo(() => {
    let breadcrumbs = [];

    if (state.selectedDatasetID && state.view === 'dataset') {
      breadcrumbs.push(<DatasetBreadcrumb
        workDir={state.selectedRepoWorkDir}
        datasetID={state.selectedDatasetID}
        onClose={() => dispatch({ type: 'close-dataset' })}
      />);
    }

    if (state.view !== 'welcome-screen' && state.selectedRepoWorkDir) {
      breadcrumbs.push(<RepoBreadcrumb
        workDir={state.selectedRepoWorkDir}
        onMessage={showMessage}
      />);
    }

    breadcrumbs.push(<Breadcrumb
      title="Paneron"
      icon={{ type: 'file', fileName: `file://${__static}/icon.png` }}
      onNavigate={state.view !== 'welcome-screen'
        ? () => dispatch({ type: 'close-dataset' })
        : undefined}
    />);

    return breadcrumbs;
  }, [state.selectedRepoWorkDir, state.selectedDatasetID, state.view]);

  return (
    <Navbar breadcrumbs={breadcrumbs} anchor={anchor} className={className}>
      {children}
    </Navbar>
  );
};


export default Nav;
