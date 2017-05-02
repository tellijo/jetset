import React from 'react';

import store from './store';

export default function containerize( Component ) {

  const masterKey = Component.key || Component.name;

  return class Container extends React.Component {

    subscription = null

    constructor( props ) {
      super( props );
      this.state = { container: null };
    }

    componentWillMount = () => {
      this.subscription = store.subscribeTo( masterKey, state => {
        if ( state ) {
          /* eslint-disable no-console */
          console.log('re-rendering', masterKey, 'based on state change:', state.toJS() );
          this.setState({ container: state });
        }
      });
    }

    componentWillUnmount = () => store.unsubscribe( this.subscription )

    getStoreState = key => store.getState([ 'containers', masterKey, key ])
    setStoreState = ( key, val ) => store.setState([ 'containers', masterKey, key ], val )

    render() {
      return (
        <Component 
          { ...this.props } 
          container={{
            get: this.getStoreState, 
            set: this.setStoreState,
            state: this.state.container
          }} 
        />
      );
    }
  };
}

export function Children({ children, container, ...props }) { // eslint-disable-line 
  return children && typeof children.type === 'function'
    ? React.cloneElement( children, props )
    : children;
}
